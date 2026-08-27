"""Ported from backend/tests/routes/dashboard.routes.test.js — same test
intent, same assertions, adapted to FakePool's queue-based mocking (see
tests/helpers/fake_pool.py) in place of Jest's `pool.query.mockResolvedValueOnce`.

Note on row shape: the Node/Jest mocks only populate the specific columns a
given test cares about and rely on JS's `undefined` (a missing property)
being falsy — e.g. `row.total_distance_km || 0`. A real Postgres SELECT
always returns every selected column (NULL for the rest), and Python dict
access via `row["key"]` raises KeyError for a genuinely absent key rather
than returning None, so the GET /today rows below explicitly fill in every
column dashboard.py's dashboard_today() reads, defaulting the ones the Node
test leaves unmentioned to None — this reproduces the same real-row shape
without weakening what's being asserted.
"""
from datetime import datetime, timezone

import pytest

from app.core.security import Employee
from app.routers import dashboard as dashboard_router_module
from tests.helpers.test_app import make_client

MANAGER = Employee(id=2, role="manager", username="priya")


def client_for(employee=MANAGER):
    return make_client(dashboard_router_module.router, prefix="/api/x", employee=employee)


def _today_row(**overrides):
    row = {
        "employee_id": 1,
        "name": "Arun",
        "region": "South",
        "attendance_id": None,
        "login_time": None,
        "logout_time": None,
        "total_distance_km": None,
        "work_mode": None,
        "day_sync_status": None,
        "dealer_name": None,
        "visit_login": None,
        "visit_logout": None,
        "last_lat": None,
        "last_lng": None,
        "needs_logout_alert": None,
        "visits_count": "0",
    }
    row.update(overrides)
    return row


class TestGetToday:
    async def test_maps_a_not_logged_in_rep_correctly(self, mock_pool):
        mock_pool.queue_fetch([_today_row(attendance_id=None, visits_count="0")])
        async with client_for() as c:
            res = await c.get("/api/x/today")
        assert res.status_code == 200
        assert res.json()["reps"][0]["status"] == "not_logged_in"

    async def test_maps_a_logged_in_at_dealer_rep_correctly(self, mock_pool):
        mock_pool.queue_fetch(
            [
                _today_row(
                    attendance_id=5,
                    login_time=datetime(2026, 7, 27, 5, 0, 0, tzinfo=timezone.utc),
                    logout_time=None,
                    dealer_name="Dealer A",
                    visit_login=datetime(2026, 7, 27, 6, 0, 0, tzinfo=timezone.utc),
                    visit_logout=None,
                    visits_count="1",
                )
            ]
        )
        async with client_for() as c:
            res = await c.get("/api/x/today")
        rep = res.json()["reps"][0]
        assert rep["status"] == "logged_in"
        assert rep["last_activity"] == "At Dealer A"

    async def test_a_logged_in_rep_on_an_office_day_shows_at_office_today_not_no_visits_yet(self, mock_pool):
        mock_pool.queue_fetch(
            [
                _today_row(
                    attendance_id=5,
                    login_time=datetime(2026, 7, 27, 5, 0, 0, tzinfo=timezone.utc),
                    logout_time=None,
                    work_mode="office",
                    dealer_name=None,
                    visit_login=None,
                    visit_logout=None,
                    visits_count="0",
                )
            ]
        )
        async with client_for() as c:
            res = await c.get("/api/x/today")
        rep = res.json()["reps"][0]
        # Still counts as "logged_in" for the dashboard's stat tiles — only the
        # label differs, so an office day doesn't disappear from that count.
        assert rep["status"] == "logged_in"
        assert rep["last_activity"] == "At office today"

    async def test_formats_a_day_ended_reps_office_logout_time_in_ist_not_server_local_time(self, mock_pool):
        mock_pool.queue_fetch(
            [
                _today_row(
                    attendance_id=5,
                    login_time=datetime(2026, 7, 27, 4, 46, 0, tzinfo=timezone.utc),
                    logout_time=datetime(2026, 7, 27, 5, 8, 0, tzinfo=timezone.utc),
                    dealer_name=None,
                    visit_login=None,
                    visit_logout=None,
                    visits_count="1",
                )
            ]
        )
        async with client_for() as c:
            res = await c.get("/api/x/today")
        rep = res.json()["reps"][0]
        assert rep["status"] == "day_ended"
        # 05:08 UTC = 10:38 IST (UTC+5:30) — asserting the IST value catches a
        # regression back to formatting in the server's own (UTC) timezone.
        assert rep["last_activity"] == "Office logout, 10:38 am"


class TestGetRepToday:
    async def test_400_on_an_invalid_rep_id(self, mock_pool):
        async with client_for() as c:
            res = await c.get("/api/x/rep/abc/today")
        assert res.status_code == 400

    async def test_404_when_the_rep_does_not_exist(self, mock_pool):
        mock_pool.queue_fetchrow(None)
        async with client_for() as c:
            res = await c.get("/api/x/rep/999/today")
        assert res.status_code == 404

    async def test_returns_null_attendance_when_the_rep_has_no_record_today(self, mock_pool):
        mock_pool.queue_fetchrow({"id": 1, "name": "Arun"})
        mock_pool.queue_fetchrow(None)
        async with client_for() as c:
            res = await c.get("/api/x/rep/1/today")
        assert res.status_code == 200
        assert res.json()["attendance"] is None
