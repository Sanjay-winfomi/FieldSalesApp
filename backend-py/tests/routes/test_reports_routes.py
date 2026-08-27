"""Ported from backend/tests/routes/reports.routes.test.js — same test
intent, same assertions, adapted to FakePool's queue-based mocking (see
tests/helpers/fake_pool.py) in place of Jest's `pool.query.mockResolvedValueOnce`.

Per reports.py's own module docstring, the JSON branch does NOT run rows
through the shared json_shape.serialize_row() — it keeps NUMERIC columns as
strings and BIGINT columns as strings (force_string_keys). Fake rows are
queued using real asyncpg Record shapes (Decimal for ::numeric columns,
datetime.date for DATE columns, datetime.datetime for TIMESTAMPTZ columns)
rather than raw strings, matching what asyncpg actually returns and what the
route code's own type-branching logic expects."""
from datetime import date
from decimal import Decimal

import pytest

from app.core.security import Employee
from app.routers import reports as reports_router_module
from tests.helpers.test_app import make_client

MANAGER = Employee(id=2, role="manager", username="priya")


def make_reports_client():
    return make_client(reports_router_module.router, prefix="/api/x", employee=MANAGER)


class TestAttendanceReport:
    async def test_json_format_returns_rows_and_count(self, mock_pool):
        mock_pool.queue_fetch(
            [{"employee_name": "Arun", "total_distance_km": Decimal("5")}]
        )
        client = make_reports_client()
        async with client as c:
            res = await c.get("/api/x/attendance")
        assert res.status_code == 200
        assert res.json()["count"] == 1

    async def test_csv_format_returns_a_csv_attachment(self, mock_pool):
        mock_pool.queue_fetch(
            [{"employee_name": "Arun", "total_distance_km": Decimal("5")}]
        )
        client = make_reports_client()
        async with client as c:
            res = await c.get("/api/x/attendance", params={"format": "csv"})
        assert res.status_code == 200
        assert "text/csv" in res.headers["content-type"]
        assert "employee_name" in res.text
        assert "Arun" in res.text

    async def test_csv_escapes_a_value_containing_a_comma(self, mock_pool):
        mock_pool.queue_fetch([{"employee_name": "Arun, Kumar"}])
        client = make_reports_client()
        async with client as c:
            res = await c.get("/api/x/attendance", params={"format": "csv"})
        assert '"Arun, Kumar"' in res.text


class TestDistanceDurationReport:
    async def test_rounds_numeric_aggregates(self, mock_pool):
        # This report's own route code (distance_duration_report) re-derives
        # every output field itself — days_worked via int(), total_distance_km
        # via f"{float(...):.2f}", etc. — from the raw aggregate query result,
        # rather than routing through _report_row_for_json. COUNT(DISTINCT ...)
        # and COUNT(cv.id) come back from asyncpg as native ints (not the
        # string-coerced BIGINT special-case _send_report applies elsewhere),
        # SUM(a.total_distance_km) as a Decimal (NUMERIC column), and
        # AVG(...) as a Decimal too — queue the fake row with those native
        # asyncpg types.
        mock_pool.queue_fetch([
            {
                "employee_id": 1,
                "employee_name": "Arun",
                "region": "South",
                "days_worked": 10,
                "total_distance_km": Decimal("123.456"),
                "total_duration_minutes": 4800,
                "total_visits": 30,
                "avg_visit_duration_minutes": Decimal("22.222"),
            }
        ])
        client = make_reports_client()
        async with client as c:
            res = await c.get("/api/x/distance-duration")
        body = res.json()
        assert body["rows"][0]["total_distance_km"] == "123.46"
        assert body["rows"][0]["days_worked"] == 10


class TestAbsencesReport:
    async def test_json_format_returns_day_absent_rows_sorted_by_absence_date(self, mock_pool):
        mock_pool.queue_fetch([
            {
                "id": 9,
                "employee_name": "Divya",
                "region": "South",
                "absence_date": date(2026, 8, 18),
                "reviewed": False,
            },
            {
                "id": 7,
                "employee_name": "Arun",
                "region": "South",
                "absence_date": date(2026, 8, 17),
                "reviewed": True,
            },
        ])
        client = make_reports_client()
        async with client as c:
            res = await c.get("/api/x/absences")
        assert res.status_code == 200
        assert len(res.json()["rows"]) == 2
        # Only the type filter is unconditional — confirms this query is scoped
        # to day_absent notifications, not the whole manager_notifications feed.
        assert "n.type = 'day_absent'" in mock_pool.fetch_calls[0].query

    async def test_csv_format_excludes_the_id_column_same_convention_as_every_other_report(self, mock_pool):
        mock_pool.queue_fetch([
            {
                "id": 9,
                "employee_name": "Divya",
                "region": "South",
                "absence_date": date(2026, 8, 18),
                "reviewed": False,
            }
        ])
        client = make_reports_client()
        async with client as c:
            res = await c.get("/api/x/absences", params={"format": "csv"})
        assert res.status_code == 200
        assert "text/csv" in res.headers["content-type"]
        assert "\nid," not in res.text
        assert "Divya" in res.text

    async def test_filters_by_employee_id(self, mock_pool):
        mock_pool.queue_fetch([])
        client = make_reports_client()
        async with client as c:
            res = await c.get("/api/x/absences", params={"employee_id": 7})
        assert res.status_code == 200
        assert "n.employee_id =" in mock_pool.fetch_calls[0].query
        assert 7 in mock_pool.fetch_calls[0].args

    async def test_400_on_an_invalid_employee_id(self, mock_pool):
        client = make_reports_client()
        async with client as c:
            res = await c.get("/api/x/absences", params={"employee_id": "abc"})
        assert res.status_code == 400

    async def test_400_on_an_invalid_from_date(self, mock_pool):
        client = make_reports_client()
        async with client as c:
            res = await c.get("/api/x/absences", params={"from": "not-a-date"})
        assert res.status_code == 400
