"""Ported from backend/tests/routes/attendance.routes.test.js — same test
intent, same assertions, adapted to FakePool's queue-based mocking (see
tests/helpers/fake_pool.py) in place of Jest's `pool.query.mockResolvedValueOnce`
/ `client.query.mockResolvedValueOnce` chaining, and to monkeypatching
attendance.py's module-level `compute_route`/`create_manager_notification`/
`notify_unvisited_assignments` references in place of Jest's
`jest.mock('../../src/services/googleRoutesService', ...)` etc."""
from datetime import datetime, timezone
from unittest.mock import AsyncMock

import pytest

from app.core.security import Employee
from app.routers import attendance as attendance_router_module
from app.services.google_routes import RouteResult, RoutesApiError
from tests.helpers.test_app import make_client

# attendance.py subtracts login_time (and the open-visit's own login_time)
# from datetime.now() to compute duration — asyncpg returns real datetime
# objects for TIMESTAMPTZ columns (unlike the Node test's raw JS-string row
# mocks, which never get parsed), so any row that reaches that arithmetic
# needs a real datetime here too. Rows only ever serialized straight back out
# (never subtracted) keep plain ISO strings, matching the Node mocks exactly.
LOGIN_TIME = datetime(2026, 7, 27, 5, 0, 0, tzinfo=timezone.utc)
VISIT_LOGIN_TIME = datetime(2026, 7, 27, 10, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def client():
    return make_client(attendance_router_module.router, prefix="/api/x")


@pytest.fixture(autouse=True)
def mocked_services(monkeypatch):
    """Default: every /logout test that reaches the final-leg computation
    gets a successful Google Routes API response, since haversine no longer
    backs it up on failure. Individual tests override this to exercise the
    failure path. Mirrors the Jest file's top-level beforeEach."""
    compute_route_mock = AsyncMock(
        return_value=RouteResult(
            distance_meters=1000,
            duration_seconds=None,
            duration_in_traffic_seconds=None,
            static_duration_seconds=None,
            encoded_polyline=None,
        )
    )
    create_manager_notification_mock = AsyncMock(return_value=None)
    notify_unvisited_assignments_mock = AsyncMock(return_value=None)
    monkeypatch.setattr(attendance_router_module, "compute_route", compute_route_mock)
    monkeypatch.setattr(attendance_router_module, "create_manager_notification", create_manager_notification_mock)
    monkeypatch.setattr(attendance_router_module, "notify_unvisited_assignments", notify_unvisited_assignments_mock)
    return {
        "compute_route": compute_route_mock,
        "create_manager_notification": create_manager_notification_mock,
        "notify_unvisited_assignments": notify_unvisited_assignments_mock,
    }


class TestLogin:
    async def test_400_when_lat_lng_missing(self, client, mock_pool):
        async with client as c:
            res = await c.post("/api/x/login", json={})
        assert res.status_code == 400

    async def test_400_when_lat_lng_out_of_range(self, client, mock_pool):
        async with client as c:
            res = await c.post("/api/x/login", json={"lat": 200, "lng": 10})
        assert res.status_code == 400

    async def test_201_creates_a_new_attendance_record(self, client, mock_pool):
        mock_pool.queue_fetchrow({"id": 5, "login_time": "2026-07-27T05:00:00Z", "login_lat": 11, "login_lng": 77})
        async with client as c:
            res = await c.post("/api/x/login", json={"lat": 11, "lng": 77})
        assert res.status_code == 201
        assert res.json()["attendance"]["id"] == 5

    async def test_400_when_accuracy_meters_present_but_invalid(self, client, mock_pool):
        async with client as c:
            res = await c.post("/api/x/login", json={"lat": 11, "lng": 77, "accuracy_meters": -5})
        assert res.status_code == 400

    async def test_422_when_accuracy_meters_exceeds_threshold(self, client, mock_pool):
        async with client as c:
            res = await c.post("/api/x/login", json={"lat": 11, "lng": 77, "accuracy_meters": 500})
        assert res.status_code == 422
        assert res.json()["error"] == "gps_accuracy_exceeded"

    async def test_201_when_accuracy_meters_omitted(self, client, mock_pool):
        mock_pool.queue_fetchrow({"id": 5, "login_time": "2026-07-27T05:00:00Z", "login_lat": 11, "login_lng": 77})
        async with client as c:
            res = await c.post("/api/x/login", json={"lat": 11, "lng": 77})
        assert res.status_code == 201

    async def test_201_when_accuracy_meters_within_threshold(self, client, mock_pool):
        mock_pool.queue_fetchrow({"id": 5, "login_time": "2026-07-27T05:00:00Z", "login_lat": 11, "login_lng": 77})
        async with client as c:
            res = await c.post("/api/x/login", json={"lat": 11, "lng": 77, "accuracy_meters": 12})
        assert res.status_code == 201

    async def test_office_day_login_succeeds_with_no_lat_lng_at_all(self, client, mock_pool):
        mock_pool.queue_fetchrow({
            "id": 5, "login_time": "2026-07-27T05:00:00Z",
            "login_lat": None, "login_lng": None, "work_mode": "office",
        })
        async with client as c:
            res = await c.post("/api/x/login", json={"work_mode": "office"})
        assert res.status_code == 201
        assert mock_pool.fetchrow_calls[0].args == (1, None, None, "office")

    async def test_office_day_login_not_blocked_by_poor_gps_accuracy_fix(self, client, mock_pool):
        mock_pool.queue_fetchrow({"id": 5, "login_time": "2026-07-27T05:00:00Z", "work_mode": "office"})
        async with client as c:
            res = await c.post(
                "/api/x/login",
                json={"work_mode": "office", "lat": 11, "lng": 77, "accuracy_meters": 500},
            )
        assert res.status_code == 201

    async def test_office_day_login_fires_plain_informational_manager_notification(self, client, mock_pool, mocked_services):
        mock_pool.queue_fetchrow({"id": 5, "login_time": "2026-07-27T05:00:00Z", "work_mode": "office"})
        async with client as c:
            res = await c.post("/api/x/login", json={"work_mode": "office"})
        assert res.status_code == 201
        mocked_services["create_manager_notification"].assert_awaited_once()
        _, kwargs = mocked_services["create_manager_notification"].call_args
        assert kwargs["type"] == "office_day"
        assert kwargs["severity"] == "info"
        assert kwargs["employee_id"] == 1

    async def test_normal_field_day_login_does_not_fire_office_day_notification(self, client, mock_pool, mocked_services):
        mock_pool.queue_fetchrow({
            "id": 5, "login_time": "2026-07-27T05:00:00Z",
            "login_lat": 11, "login_lng": 77, "work_mode": "field",
        })
        async with client as c:
            res = await c.post("/api/x/login", json={"lat": 11, "lng": 77})
        assert res.status_code == 201
        mocked_services["create_manager_notification"].assert_not_awaited()

    async def test_400_when_lat_lng_missing_on_a_field_day_login(self, client, mock_pool):
        async with client as c:
            res = await c.post("/api/x/login", json={"work_mode": "field"})
        assert res.status_code == 400

    async def test_409_with_existing_attendance_id_when_already_logged_in_today(self, client, mock_pool):
        mock_pool.queue_fetchrow(None)  # INSERT ... ON CONFLICT DO NOTHING -> no row
        mock_pool.queue_fetchrow({"id": 9})  # SELECT existing
        async with client as c:
            res = await c.post("/api/x/login", json={"lat": 11, "lng": 77})
        assert res.status_code == 409
        assert res.json()["attendance_id"] == 9


class TestLogout:
    async def test_400_when_attendance_id_or_coords_missing(self, client, mock_pool):
        async with client as c:
            res = await c.post("/api/x/logout", json={"lat": 11, "lng": 77})
        assert res.status_code == 400

    async def test_422_when_accuracy_meters_exceeds_threshold_on_field_day(self, client, mock_pool):
        mock_pool.queue_fetchrow({
            "id": 5, "login_time": "2026-07-27T05:00:00Z", "login_lat": 11, "login_lng": 77,
            "logout_time": None, "total_distance_km": 3, "work_mode": "field",
        })
        async with client as c:
            res = await c.post(
                "/api/x/logout",
                json={"attendance_id": 5, "lat": 11, "lng": 77, "accuracy_meters": 500},
            )
        assert res.status_code == 422
        assert res.json()["error"] == "gps_accuracy_exceeded"

    async def test_accuracy_exceeding_threshold_does_not_block_logout_on_office_day(self, client, mock_pool):
        mock_pool.queue_fetchrow({
            "id": 5, "login_time": LOGIN_TIME, "login_lat": 11, "login_lng": 77,
            "logout_time": None, "total_distance_km": 3, "work_mode": "office",
        })  # attendance (FOR UPDATE)
        mock_pool.queue_fetchrow(None)  # no open dealer visit
        mock_pool.queue_fetchrow(None)  # no closed dealer visits either — final leg falls back to login point
        mock_pool.queue_fetchrow({
            "id": 5, "login_time": "2026-07-27T05:00:00Z", "logout_time": "2026-07-27T13:00:00Z",
            "total_distance_km": 3, "total_duration_minutes": 480, "work_mode": "office",
        })  # UPDATE attendance
        mock_pool.queue_fetchrow({"visits_count": 0})  # visits count
        async with client as c:
            res = await c.post(
                "/api/x/logout",
                json={"attendance_id": 5, "lat": 11, "lng": 77, "accuracy_meters": 500},
            )
        assert res.status_code == 200

    async def test_404_when_attendance_record_does_not_belong_to_this_employee(self, client, mock_pool):
        mock_pool.queue_fetchrow(None)  # attendance (FOR UPDATE) — not found
        async with client as c:
            res = await c.post("/api/x/logout", json={"attendance_id": 5, "lat": 11, "lng": 77})
        assert res.status_code == 404
        assert len(mock_pool.released_connections) == 1

    async def test_409_with_authoritative_record_when_already_logged_out(self, client, mock_pool):
        mock_pool.queue_fetchrow({
            "id": 5, "login_time": "2026-07-27T05:00:00Z",
            "logout_time": "2026-07-27T13:00:00Z", "total_distance_km": 3,
        })  # attendance (FOR UPDATE) — already logged out
        async with client as c:
            res = await c.post("/api/x/logout", json={"attendance_id": 5, "lat": 11, "lng": 77})
        assert res.status_code == 409
        assert res.json()["attendance"] == {"id": 5, "logout_time": "2026-07-27T13:00:00Z"}

    async def test_200_logs_out_successfully_with_a_visit_summary(self, client, mock_pool):
        mock_pool.queue_fetchrow({
            "id": 5, "login_time": LOGIN_TIME, "login_lat": 11, "login_lng": 77,
            "logout_time": None, "total_distance_km": 3, "work_mode": "field",
        })  # attendance (FOR UPDATE)
        mock_pool.queue_fetchrow(None)  # no open dealer visit
        mock_pool.queue_fetchrow(None)  # no closed dealer visits either — final leg falls back to login point
        mock_pool.queue_fetchrow({
            "id": 5, "login_time": "2026-07-27T05:00:00Z", "logout_time": "2026-07-27T13:00:00Z",
            "total_distance_km": 3, "total_duration_minutes": 480,
        })  # UPDATE attendance
        mock_pool.queue_fetchrow({"visits_count": 4})  # visits count
        async with client as c:
            res = await c.post("/api/x/logout", json={"attendance_id": 5, "lat": 11, "lng": 77})
        assert res.status_code == 200
        assert res.json()["summary"]["visits_count"] == 4
        assert len(mock_pool.released_connections) == 1

    async def test_502_with_retry_message_when_routes_api_fails_for_final_leg(self, client, mock_pool, mocked_services):
        mocked_services["compute_route"].side_effect = RoutesApiError("upstream failed")
        mock_pool.queue_fetchrow({
            "id": 5, "login_time": LOGIN_TIME, "login_lat": 11, "login_lng": 77,
            "logout_time": None, "total_distance_km": 3, "work_mode": "field",
        })  # attendance (FOR UPDATE)
        mock_pool.queue_fetchrow(None)  # no open dealer visit
        mock_pool.queue_fetchrow(None)  # no closed dealer visits either
        async with client as c:
            res = await c.post("/api/x/logout", json={"attendance_id": 5, "lat": 11, "lng": 77})
        assert res.status_code == 502
        body = res.json()
        assert body["error"] == "route_computation_failed"
        assert body["message"] == "Request timed out — Retry"
        # The day was never actually logged out — no UPDATE attendance call, and
        # the transaction was rolled back and its connection released instead of leaking.
        all_queries = [call.query for call in mock_pool.fetchrow_calls + mock_pool.execute_calls]
        assert not any("UPDATE attendance" in q for q in all_queries)
        assert len(mock_pool.released_connections) == 1
        conn = mock_pool.released_connections[0]
        assert len(conn.transactions) == 1
        assert conn.transactions[0].rolled_back is True

    async def test_409_when_a_concurrent_logout_request_wins_the_race(self, client, mock_pool):
        mock_pool.queue_fetchrow({
            "id": 5, "login_time": LOGIN_TIME, "login_lat": 11, "login_lng": 77,
            "logout_time": None, "total_distance_km": 3, "work_mode": "field",
        })  # attendance (FOR UPDATE)
        mock_pool.queue_fetchrow(None)  # no open dealer visit
        mock_pool.queue_fetchrow(None)  # no closed dealer visits either
        # The UPDATE ... WHERE logout_time IS NULL matches zero rows — a
        # concurrent request already completed the logout in between.
        mock_pool.queue_fetchrow(None)
        # The lost-race authoritative re-fetch runs on the plain pool (not the
        # transaction connection), since the transaction has already rolled back
        # by then — same shared fetchrow queue, so just the next queued value.
        mock_pool.queue_fetchrow({"id": 5, "logout_time": "2026-07-27T13:00:01Z"})
        async with client as c:
            res = await c.post("/api/x/logout", json={"attendance_id": 5, "lat": 11, "lng": 77})
        assert res.status_code == 409
        assert res.json()["attendance"] == {"id": 5, "logout_time": "2026-07-27T13:00:01Z"}

    async def test_auto_closes_a_still_open_dealer_visit_when_the_day_ends(self, client, mock_pool, mocked_services):
        mock_pool.queue_fetchrow({
            "id": 5, "login_time": LOGIN_TIME, "login_lat": 11, "login_lng": 77,
            "logout_time": None, "total_distance_km": 3, "work_mode": "field",
        })  # attendance (FOR UPDATE)
        mock_pool.queue_fetchrow({
            "id": 90, "dealer_id": 7, "login_time": VISIT_LOGIN_TIME, "dealer_name": "Dealer Z",
            "dealer_lat": 11, "dealer_lng": 77, "dealer_radius_meters": 200,
        })  # open dealer visit found
        mock_pool.queue_execute("UPDATE 1")  # UPDATE client_visits (auto-close) — this request won the race
        mock_pool.queue_fetchrow({"logout_lat": 11, "logout_lng": 77})  # final leg origin = the just-auto-closed visit's logout point
        mock_pool.queue_fetchrow({
            "id": 5, "login_time": "2026-07-27T05:00:00Z", "logout_time": "2026-07-27T13:00:00Z",
            "total_distance_km": 3, "total_duration_minutes": 480,
        })  # UPDATE attendance
        mock_pool.queue_fetchrow({"visits_count": 1})  # visits count
        async with client as c:
            res = await c.post("/api/x/logout", json={"attendance_id": 5, "lat": 11, "lng": 77})
        assert res.status_code == 200
        # The UPDATE ...client_visits call is the only queued execute() call.
        update_call = mock_pool.execute_calls[0]
        assert "UPDATE client_visits" in update_call.query
        assert "AND logout_time IS NULL" in update_call.query
        assert update_call.args[0] == 11
        assert update_call.args[1] == 77
        assert isinstance(update_call.args[2], (int, float))
        assert update_call.args[3] is False
        assert isinstance(update_call.args[4], str)
        assert update_call.args[5] == 90
        # The auto-close notification is only sent once the transaction has actually committed.
        mocked_services["create_manager_notification"].assert_awaited_once()
        _, kwargs = mocked_services["create_manager_notification"].call_args
        assert kwargs["type"] == "visit_auto_closed_on_day_logout"
        assert kwargs["dealer_id"] == 7
        assert kwargs["visit_id"] == 90

    async def test_does_not_overwrite_or_notify_when_a_manual_dealer_logout_wins_the_race(self, client, mock_pool, mocked_services):
        mock_pool.queue_fetchrow({
            "id": 5, "login_time": LOGIN_TIME, "login_lat": 11, "login_lng": 77,
            "logout_time": None, "total_distance_km": 3, "work_mode": "field",
        })  # attendance (FOR UPDATE)
        mock_pool.queue_fetchrow({
            "id": 90, "dealer_id": 7, "login_time": VISIT_LOGIN_TIME, "dealer_name": "Dealer Z",
            "dealer_lat": 11, "dealer_lng": 77, "dealer_radius_meters": 200,
        })  # stale read — a concurrent manual logout closes the visit before the UPDATE below runs
        mock_pool.queue_execute("UPDATE 0")  # lost the race — logout_time was no longer NULL
        mock_pool.queue_fetchrow(None)  # final-leg origin lookup — no closed visits found for this stale state
        mock_pool.queue_fetchrow({
            "id": 5, "login_time": "2026-07-27T05:00:00Z", "logout_time": "2026-07-27T13:00:00Z",
            "total_distance_km": 3, "total_duration_minutes": 480,
        })  # UPDATE attendance
        mock_pool.queue_fetchrow({"visits_count": 1})  # visits count
        async with client as c:
            res = await c.post("/api/x/logout", json={"attendance_id": 5, "lat": 11, "lng": 77})
        assert res.status_code == 200
        # The UPDATE lost the race (status "UPDATE 0"), so autoClosedVisit stays
        # None and the auto-close notification must never fire.
        for call in mocked_services["create_manager_notification"].call_args_list:
            _, kwargs = call
            assert kwargs.get("type") != "visit_auto_closed_on_day_logout"


class TestGetToday:
    async def test_returns_null_attendance_when_no_record_exists_for_today(self, client, mock_pool):
        mock_pool.queue_fetchrow(None)
        async with client as c:
            res = await c.get("/api/x/today")
        assert res.status_code == 200
        body = res.json()
        assert body["attendance"] is None
        assert body["visits"] == []


class TestGetByIdAuthorization:
    async def test_403_when_a_rep_requests_another_employees_attendance_record(self, mock_pool):
        mock_pool.queue_fetchrow({"id": 5, "employee_id": 999})
        client = make_client(
            attendance_router_module.router, prefix="/api/x",
            employee=Employee(id=1, role="rep", username="arun"),
        )
        async with client as c:
            res = await c.get("/api/x/5")
        assert res.status_code == 403

    async def test_a_manager_can_view_any_attendance_record(self, mock_pool):
        mock_pool.queue_fetchrow({"id": 5, "employee_id": 999})
        client = make_client(
            attendance_router_module.router, prefix="/api/x",
            employee=Employee(id=1, role="manager", username="priya"),
        )
        async with client as c:
            res = await c.get("/api/x/5")
        assert res.status_code == 200
