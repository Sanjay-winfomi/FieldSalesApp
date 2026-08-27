"""Ported from backend/tests/routes/visits.routes.test.js — same test intent,
same assertions, adapted to FakePool's queue-based mocking (see
tests/helpers/fake_pool.py) in place of Jest's `pool.query.mockResolvedValueOnce`
/ `pool.connect.mockResolvedValueOnce(client)`.

Key adaptations from the Jest source (documented inline where they matter):
  - visits.py's POST /login runs inside `conn = await pool.get_pool().acquire()`
    + `conn.transaction()`; FakeConnection shares its parent FakePool's
    fetch/fetchrow/execute queues (see fake_pool.py), so queuing on
    `mock_pool` backs both the module-level pool.* calls (logout,
    location-check) and the transactional conn.* calls (login) the same way
    a single Jest `pool.query` mock backs both `pool.query()` and
    `client.query()` there.
  - BEGIN/COMMIT/ROLLBACK are NOT queued — FakeTransaction's start()/commit()/
    rollback() are structural no-ops with no corresponding DB-queue entry.
  - Timestamp columns: Jest's mock rows carry plain strings for
    login_time/logout_time (JS's `pool.query` mock never round-trips through
    a real date parser). asyncpg, by contrast, always returns real
    `datetime` objects for timestamptz columns, and visits.py's logout /
    location-check paths do real datetime arithmetic
    (`datetime.now(timezone.utc) - visit["login_time"]`,
    `datetime.now(timezone.utc) - open_event["left_at"]`). Queuing a plain
    string there would raise a TypeError inside the route (not a Node
    behavioral difference — just an artifact of the two mocks' fidelity), so
    those fields are queued as real aware `datetime` objects here. Where the
    route only forwards a timestamp untouched (no arithmetic), a plain
    string is queued instead, matching Jest's literal value exactly (e.g.
    the 409-already-logged-out logout_time).
  - `updated["should_send_logout_alert"]` / `claim.rowCount` etc.: Jest's
    mocked rows can omit a key entirely and JS treats it as `undefined`
    (falsy); Python dict/asyncpg.Record access requires the key to be
    present, so every queued row here explicitly includes
    `should_send_logout_alert` (and similar) even where the Jest fixture
    left it out — same effective value (falsy/False), just spelled out.
  - asyncpg's `execute()` returns a status string ("UPDATE 1" / "UPDATE 0"),
    not a `rowCount` — the Jest `rowCount: 1` / `rowCount: 0` CAS races are
    queued here as `queue_execute("UPDATE 1")` / `queue_execute("UPDATE 0")`.
"""
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest

from app.routers import visits as visits_router_module
from app.services.google_routes import RouteResult, RoutesApiError
from tests.helpers.test_app import make_client

REP = {"id": 1, "role": "rep", "username": "arun"}
MANAGER = {"id": 2, "role": "manager", "username": "priya"}


def _employee(d):
    from app.core.security import Employee

    return Employee(id=d["id"], role=d["role"], username=d["username"])


def _route_result(distance_meters=1000):
    return RouteResult(
        distance_meters=distance_meters,
        duration_seconds=None,
        duration_in_traffic_seconds=None,
        static_duration_seconds=None,
        encoded_polyline=None,
    )


@pytest.fixture(autouse=True)
def compute_route_mock(monkeypatch):
    # beforeEach's default: every /login test that reaches the dealer-to-dealer
    # leg computation gets a successful Google Routes API response, since
    # haversine no longer backs it up on failure. Individual tests override
    # this to exercise the failure path.
    mock = AsyncMock(return_value=_route_result(1000))
    monkeypatch.setattr(visits_router_module, "compute_route", mock)
    return mock


@pytest.fixture(autouse=True)
def create_manager_notification_mock(monkeypatch):
    mock = AsyncMock(return_value=None)
    monkeypatch.setattr(visits_router_module, "create_manager_notification", mock)
    return mock


@pytest.fixture(autouse=True)
def mark_assignment_visited_mock(monkeypatch):
    mock = AsyncMock(return_value=None)
    monkeypatch.setattr(visits_router_module, "mark_assignment_visited", mock)
    return mock


def rep_client():
    return make_client(visits_router_module.router, prefix="/api/x", employee=_employee(REP))


def manager_client():
    return make_client(visits_router_module.router, prefix="/api/x", employee=_employee(MANAGER))


class TestLogin:
    async def test_400_when_required_fields_missing(self, mock_pool):
        async with rep_client() as c:
            res = await c.post("/api/x/login", json={"dealer_id": 1})
        assert res.status_code == 400

    async def test_422_when_gps_accuracy_exceeds_threshold(self, mock_pool):
        async with rep_client() as c:
            res = await c.post(
                "/api/x/login",
                json={"attendance_id": 1, "dealer_id": 1, "lat": 11, "lng": 77, "accuracy_meters": 999},
            )
        assert res.status_code == 422
        assert res.json()["error"] == "gps_accuracy_exceeded"

    async def test_422_reason_required_when_outside_radius_and_no_reason_given(self, mock_pool):
        mock_pool.queue_fetchrow({"id": 1, "login_lat": 11, "login_lng": 77})  # attendance (FOR UPDATE)
        mock_pool.queue_fetchrow(None)  # no open visit
        mock_pool.queue_fetchrow(
            {"id": 1, "name": "Dealer A", "latitude": 11, "longitude": 77, "radius_meters": 100}
        )  # dealer
        async with rep_client() as c:
            res = await c.post(
                "/api/x/login",
                json={"attendance_id": 1, "dealer_id": 1, "lat": 12, "lng": 78, "accuracy_meters": 10},
            )  # ~150km away
        assert res.status_code == 422
        assert res.json()["error"] == "reason_required"
        assert len(mock_pool.released_connections) == 1

    async def test_201_logs_in_successfully_inside_the_radius(self, mock_pool):
        mock_pool.queue_fetchrow({"id": 1, "login_lat": 11, "login_lng": 77})  # attendance (FOR UPDATE)
        mock_pool.queue_fetchrow(None)  # no open visit
        mock_pool.queue_fetchrow(
            {"id": 1, "name": "Dealer A", "latitude": 11, "longitude": 77, "radius_meters": 200}
        )  # dealer
        mock_pool.queue_fetchrow(None)  # last visit (none)
        mock_pool.queue_fetchrow(
            {
                "id": 55, "dealer_id": 1, "login_time": datetime(2026, 7, 27, 5, 0, 0, tzinfo=timezone.utc),
                "login_lat": 11, "login_lng": 77, "distance_from_previous_km": 1.0,
                "distance_is_routed": True, "login_distance_m": 0.0, "login_inside_radius": True,
            }
        )  # insert visit
        mock_pool.queue_execute("UPDATE 1")  # update attendance distance
        async with rep_client() as c:
            res = await c.post(
                "/api/x/login",
                json={"attendance_id": 1, "dealer_id": 1, "lat": 11, "lng": 77, "accuracy_meters": 10},
            )
        assert res.status_code == 201
        body = res.json()
        assert body["visit"]["id"] == 55
        assert body["visit"]["dealer_name"] == "Dealer A"
        assert len(mock_pool.released_connections) == 1

    async def test_502_with_retry_message_when_routes_api_fails(self, mock_pool, compute_route_mock):
        compute_route_mock.side_effect = RoutesApiError("upstream failed")
        mock_pool.queue_fetchrow({"id": 1, "login_lat": 11, "login_lng": 77})  # attendance
        mock_pool.queue_fetchrow(None)  # no open visit
        mock_pool.queue_fetchrow(
            {"id": 1, "name": "Dealer A", "latitude": 11, "longitude": 77, "radius_meters": 200}
        )  # dealer
        mock_pool.queue_fetchrow(None)  # last visit (none)
        async with rep_client() as c:
            res = await c.post(
                "/api/x/login",
                json={"attendance_id": 1, "dealer_id": 1, "lat": 11, "lng": 77, "accuracy_meters": 10},
            )
        assert res.status_code == 502
        assert res.json()["error"] == "route_computation_failed"
        assert res.json()["message"] == "Request timed out — Retry"
        assert len(mock_pool.released_connections) == 1
        # No visit was inserted — the transaction rolled back before that INSERT.
        assert not any(
            "INSERT INTO client_visits" in call.query for call in mock_pool.fetchrow_calls
        )

    async def test_404_when_dealer_does_not_exist(self, mock_pool):
        mock_pool.queue_fetchrow({"id": 1, "login_lat": 11, "login_lng": 77})  # attendance
        mock_pool.queue_fetchrow(None)  # no open visit
        mock_pool.queue_fetchrow(None)  # dealer not found
        async with rep_client() as c:
            res = await c.post(
                "/api/x/login",
                json={"attendance_id": 1, "dealer_id": 999, "lat": 11, "lng": 77, "accuracy_meters": 10},
            )
        assert res.status_code == 404
        assert len(mock_pool.released_connections) == 1

    async def test_409_visit_already_open(self, mock_pool):
        mock_pool.queue_fetchrow({"id": 1, "login_lat": 11, "login_lng": 77})  # attendance
        mock_pool.queue_fetchrow({"id": 55, "dealer_id": 2, "dealer_name": "Dealer B"})  # open visit found
        async with rep_client() as c:
            res = await c.post(
                "/api/x/login",
                json={"attendance_id": 1, "dealer_id": 1, "lat": 11, "lng": 77, "accuracy_meters": 10},
            )
        assert res.status_code == 409
        assert res.json()["error"] == "visit_already_open"
        assert res.json()["visit"] == {"id": 55, "dealer_id": 2, "dealer_name": "Dealer B"}
        assert len(mock_pool.released_connections) == 1


class TestLogout:
    async def test_409_with_authoritative_visit_record_when_already_logged_out(self, mock_pool):
        mock_pool.queue_fetchrow(
            {
                "id": 55, "attendance_id": 1, "dealer_id": 1,
                "login_time": datetime(2026, 7, 27, 5, 0, 0, tzinfo=timezone.utc),
                "logout_time": "2026-07-27T06:00:00Z",
                "login_lat": 11, "login_lng": 77,
                "dealer_name": "Dealer A", "dealer_lat": 11, "dealer_lng": 77, "dealer_radius_meters": 200,
                "login_inside_radius": True,
            }
        )
        async with rep_client() as c:
            res = await c.post(
                "/api/x/logout", json={"visit_id": 55, "lat": 11, "lng": 77, "accuracy_meters": 10}
            )
        assert res.status_code == 409
        assert res.json()["visit"] == {"id": 55, "logout_time": "2026-07-27T06:00:00Z"}

    async def test_200_logs_out_successfully_inside_the_radius(self, mock_pool):
        mock_pool.queue_fetchrow(
            {
                "id": 55, "attendance_id": 1, "dealer_id": 1,
                "login_time": datetime(2026, 7, 27, 5, 0, 0, tzinfo=timezone.utc),
                "logout_time": None,
                "login_lat": 11, "login_lng": 77, "login_inside_radius": True,
                "dealer_name": "Dealer A", "dealer_lat": 11, "dealer_lng": 77, "dealer_radius_meters": 200,
            }
        )
        mock_pool.queue_fetchrow(
            {"id": 55, "logout_time": "now", "visit_duration_minutes": 30, "out_of_radius": False, "matched_login": False}
        )
        async with rep_client() as c:
            res = await c.post(
                "/api/x/logout", json={"visit_id": 55, "lat": 11, "lng": 77, "accuracy_meters": 10}
            )
        assert res.status_code == 200
        assert res.json()["visit"]["out_of_radius"] is False
        assert res.json()["visit"]["needs_verification"] is False

    # Task 5 Case 1 — a normal (non-exception) login, logging out from
    # outside the dealer radius and not drift-matched to the login spot,
    # requires a written reason (50-500 chars) instead of a hard reject.
    async def test_422_reason_required_for_normal_login_visit_outside_radius_no_reason(self, mock_pool):
        mock_pool.queue_fetchrow(
            {
                "id": 55, "attendance_id": 1, "dealer_id": 1,
                "login_time": datetime(2026, 7, 27, 5, 0, 0, tzinfo=timezone.utc),
                "logout_time": None,
                "login_lat": 11, "login_lng": 77, "login_inside_radius": True,
                "dealer_name": "Dealer A", "dealer_lat": 11, "dealer_lng": 77, "dealer_radius_meters": 100,
            }
        )
        async with rep_client() as c:
            res = await c.post(
                "/api/x/logout", json={"visit_id": 55, "lat": 12, "lng": 78, "accuracy_meters": 10}
            )
        assert res.status_code == 422
        assert res.json()["error"] == "reason_required"
        assert res.json()["minLength"] == 50
        assert res.json()["maxLength"] == 500

    async def test_200_logs_out_normal_login_visit_outside_radius_with_valid_reason(self, mock_pool):
        mock_pool.queue_fetchrow(
            {
                "id": 55, "attendance_id": 1, "dealer_id": 1,
                "login_time": datetime(2026, 7, 27, 5, 0, 0, tzinfo=timezone.utc),
                "logout_time": None,
                "login_lat": 11, "login_lng": 77, "login_inside_radius": True,
                "dealer_name": "Dealer A", "dealer_lat": 11, "dealer_lng": 77, "dealer_radius_meters": 100,
            }
        )
        mock_pool.queue_fetchrow(
            {"id": 55, "logout_time": "now", "visit_duration_minutes": 30, "out_of_radius": True, "matched_login": False}
        )
        mock_pool.queue_execute("UPDATE 1")  # exception_log insert
        async with rep_client() as c:
            res = await c.post(
                "/api/x/logout",
                json={
                    "visit_id": 55, "lat": 12, "lng": 78, "accuracy_meters": 10,
                    "reason": "A perfectly long, valid-looking reason string here",
                },
            )
        assert res.status_code == 200
        assert res.json()["visit"]["out_of_radius"] is True

    # Task 5 Case 2 — login already used an exception: logout always requires
    # a written reason (50-500 chars), regardless of current distance.
    async def test_422_reason_required_for_exception_login_visit_even_inside_radius(self, mock_pool):
        mock_pool.queue_fetchrow(
            {
                "id": 55, "attendance_id": 1, "dealer_id": 1,
                "login_time": datetime(2026, 7, 27, 5, 0, 0, tzinfo=timezone.utc),
                "logout_time": None,
                "login_lat": 11, "login_lng": 77, "login_inside_radius": False,
                "dealer_name": "Dealer A", "dealer_lat": 11, "dealer_lng": 77, "dealer_radius_meters": 200,
            }
        )
        async with rep_client() as c:
            res = await c.post(
                "/api/x/logout",
                json={"visit_id": 55, "lat": 11, "lng": 77, "accuracy_meters": 10, "reason": "too short"},
            )
        assert res.status_code == 422
        assert res.json()["error"] == "reason_required"
        assert res.json()["minLength"] == 50
        assert res.json()["maxLength"] == 500

    # Task 5 Case 3 — exception at BOTH login and logout is flagged for the
    # manager dashboard's "Needs Verification" status.
    async def test_needs_verification_true_when_both_login_and_logout_used_exception(self, mock_pool):
        long_reason = "x" * 60
        mock_pool.queue_fetchrow(
            {
                "id": 55, "attendance_id": 1, "dealer_id": 1,
                "login_time": datetime(2026, 7, 27, 5, 0, 0, tzinfo=timezone.utc),
                "logout_time": None,
                "login_lat": 11, "login_lng": 77, "login_inside_radius": False,
                "dealer_name": "Dealer A", "dealer_lat": 11, "dealer_lng": 77, "dealer_radius_meters": 100,
            }
        )
        mock_pool.queue_fetchrow(
            {"id": 55, "logout_time": "now", "visit_duration_minutes": 30, "out_of_radius": True, "matched_login": False}
        )
        mock_pool.queue_execute("UPDATE 1")  # exception_log insert
        async with rep_client() as c:
            res = await c.post(
                "/api/x/logout",
                json={"visit_id": 55, "lat": 12, "lng": 78, "accuracy_meters": 10, "reason": long_reason},
            )
        assert res.status_code == 200
        assert res.json()["visit"]["needs_verification"] is True


class TestLocationCheck:
    async def test_400_on_invalid_lat_lng(self, mock_pool):
        async with rep_client() as c:
            res = await c.post("/api/x/55/location-check", json={"lat": 999, "lng": 77})
        assert res.status_code == 400

    async def test_404_when_visit_does_not_belong_to_employee(self, mock_pool):
        mock_pool.queue_fetchrow(None)
        async with rep_client() as c:
            res = await c.post("/api/x/55/location-check", json={"lat": 11, "lng": 77})
        assert res.status_code == 404

    async def test_records_inside_without_incrementing_breach_count(self, mock_pool):
        mock_pool.queue_fetchrow(
            {
                "id": 55, "dealer_id": 1, "logout_time": None, "outside_radius_count": 0, "log_out_alert_sent": False,
                "dealer_name": "Dealer A", "dealer_lat": 11, "dealer_lng": 77, "radius_meters": 200, "employee_name": "Arun",
            }
        )
        mock_pool.queue_fetchrow(
            {
                "id": 55, "last_location_status": "inside", "outside_radius_count": 0, "log_out_alert_sent": False,
                "interrupted": False, "should_send_logout_alert": False,
            }
        )
        mock_pool.queue_fetchrow(None)  # visit_radius_events open-event lookup — none, inside, nothing else to do
        async with rep_client() as c:
            res = await c.post("/api/x/55/location-check", json={"lat": 11, "lng": 77})
        assert res.status_code == 200
        assert res.json()["visit"]["last_location_status"] == "inside"
        # select, update, radius-events lookup — no exception_log insert.
        # Jest counts a single `pool.query` mock across all statement kinds;
        # our FakePool splits by kind, so the equivalent total is the sum of
        # all three call lists.
        total_calls = len(mock_pool.fetch_calls) + len(mock_pool.fetchrow_calls) + len(mock_pool.execute_calls)
        assert total_calls == 3

    async def test_one_breach_increments_count_but_does_not_trigger_logout_alert(self, mock_pool):
        mock_pool.queue_fetchrow(
            {
                "id": 55, "dealer_id": 1, "logout_time": None, "outside_radius_count": 0, "log_out_alert_sent": False,
                "dealer_name": "Dealer A", "dealer_lat": 11, "dealer_lng": 77, "radius_meters": 100, "employee_name": "Arun",
            }
        )
        mock_pool.queue_fetchrow(
            {
                "id": 55, "last_location_status": "outside", "outside_radius_count": 1, "log_out_alert_sent": False,
                "interrupted": False, "should_send_logout_alert": False,
            }
        )
        mock_pool.queue_fetchrow(None)  # visit_radius_events open-event lookup — none yet
        mock_pool.queue_execute("UPDATE 1")  # visit_radius_events insert — excursion starts, no alert on first check
        async with rep_client() as c:
            res = await c.post("/api/x/55/location-check", json={"lat": 12, "lng": 78})  # ~150km away
        assert res.status_code == 200
        assert res.json()["visit"]["outside_radius_count"] == 1
        assert res.json()["visit"]["log_out_alert_sent"] is False
        total_calls = len(mock_pool.fetch_calls) + len(mock_pool.fetchrow_calls) + len(mock_pool.execute_calls)
        assert total_calls == 4  # still no exception_log insert

    async def test_second_breach_non_consecutive_trips_logout_alert_and_logs_exception(self, mock_pool):
        mock_pool.queue_fetchrow(
            {
                "id": 55, "dealer_id": 1, "logout_time": None, "outside_radius_count": 1, "log_out_alert_sent": False,
                "dealer_name": "Dealer A", "dealer_lat": 11, "dealer_lng": 77, "radius_meters": 100, "employee_name": "Arun",
            }
        )
        mock_pool.queue_fetchrow(
            {
                "id": 55, "last_location_status": "outside", "outside_radius_count": 2, "log_out_alert_sent": True,
                "interrupted": True, "should_send_logout_alert": True,
            }
        )
        mock_pool.queue_execute("UPDATE 1")  # exception_log insert
        mock_pool.queue_fetchrow(None)  # visit_radius_events open-event lookup — non-consecutive, no open excursion right now
        mock_pool.queue_execute("UPDATE 1")  # visit_radius_events insert — new excursion starts
        async with rep_client() as c:
            res = await c.post("/api/x/55/location-check", json={"lat": 12, "lng": 78})
        assert res.status_code == 200
        assert res.json()["visit"]["log_out_alert_sent"] is True
        total_calls = len(mock_pool.fetch_calls) + len(mock_pool.fetchrow_calls) + len(mock_pool.execute_calls)
        assert total_calls == 5

    async def test_already_alerted_visit_stays_idempotent_no_duplicate_exception_log_insert(self, mock_pool):
        mock_pool.queue_fetchrow(
            {
                "id": 55, "dealer_id": 1, "logout_time": None, "outside_radius_count": 3, "log_out_alert_sent": True,
                "dealer_name": "Dealer A", "dealer_lat": 11, "dealer_lng": 77, "radius_meters": 100, "employee_name": "Arun",
            }
        )
        mock_pool.queue_fetchrow(
            {
                "id": 55, "last_location_status": "outside", "outside_radius_count": 4, "log_out_alert_sent": True,
                "interrupted": True, "should_send_logout_alert": False,
            }
        )
        # Open excursion already tracked, just started (left_at ~now) — dueStage
        # is still 0 so no new alert fires, just the max-distance/count update.
        mock_pool.queue_fetchrow(
            {"id": 9, "left_at": datetime.now(timezone.utc), "alert_count": 0, "max_distance_m": 100}
        )
        mock_pool.queue_execute("UPDATE 1")  # visit_radius_events update (unconditional CAS write)
        async with rep_client() as c:
            res = await c.post("/api/x/55/location-check", json={"lat": 12, "lng": 78})
        assert res.status_code == 200
        total_calls = len(mock_pool.fetch_calls) + len(mock_pool.fetchrow_calls) + len(mock_pool.execute_calls)
        assert total_calls == 4  # no new exception_log insert

    async def test_staged_alert_not_double_sent_when_concurrent_request_already_claimed_stage(
        self, mock_pool, create_manager_notification_mock
    ):
        left_at = datetime.now(timezone.utc) - timedelta(minutes=15)  # 15 min outside — stage 1 is due
        mock_pool.queue_fetchrow(
            {
                "id": 55, "dealer_id": 1, "logout_time": None, "outside_radius_count": 5, "log_out_alert_sent": True,
                "dealer_name": "Dealer A", "dealer_lat": 11, "dealer_lng": 77, "radius_meters": 100, "employee_name": "Arun",
            }
        )
        mock_pool.queue_fetchrow(
            {
                "id": 55, "last_location_status": "outside", "outside_radius_count": 6, "log_out_alert_sent": True,
                "interrupted": True, "should_send_logout_alert": False,
            }
        )
        mock_pool.queue_fetchrow({"id": 9, "left_at": left_at, "alert_count": 0, "max_distance_m": 100})  # open excursion, stage 1 due
        # The CAS UPDATE finds status "UPDATE 0" — a concurrent request already
        # advanced alert_count away from the value this request read.
        mock_pool.queue_execute("UPDATE 0")

        async with rep_client() as c:
            res = await c.post("/api/x/55/location-check", json={"lat": 12, "lng": 78})

        assert res.status_code == 200
        create_manager_notification_mock.assert_not_called()
        assert res.json()["rep_notification"] is None

    async def test_staged_alert_is_sent_when_this_request_wins_cas_claim(self, mock_pool, create_manager_notification_mock):
        left_at = datetime.now(timezone.utc) - timedelta(minutes=15)
        mock_pool.queue_fetchrow(
            {
                "id": 55, "dealer_id": 1, "logout_time": None, "outside_radius_count": 5, "log_out_alert_sent": True,
                "dealer_name": "Dealer A", "dealer_lat": 11, "dealer_lng": 77, "radius_meters": 100, "employee_name": "Arun",
            }
        )
        mock_pool.queue_fetchrow(
            {
                "id": 55, "last_location_status": "outside", "outside_radius_count": 6, "log_out_alert_sent": True,
                "interrupted": True, "should_send_logout_alert": False,
            }
        )
        mock_pool.queue_fetchrow({"id": 9, "left_at": left_at, "alert_count": 0, "max_distance_m": 100})
        mock_pool.queue_execute("UPDATE 1")  # this request's CAS wins

        async with rep_client() as c:
            res = await c.post("/api/x/55/location-check", json={"lat": 12, "lng": 78})

        assert res.status_code == 200
        assert create_manager_notification_mock.await_count == 1
        _, kwargs = create_manager_notification_mock.await_args
        assert kwargs["type"] == "left_dealer"

    async def test_returned_notification_not_double_sent_when_concurrent_request_already_closed_excursion(
        self, mock_pool, create_manager_notification_mock
    ):
        mock_pool.queue_fetchrow(
            {
                "id": 55, "dealer_id": 1, "logout_time": None, "outside_radius_count": 3, "log_out_alert_sent": True,
                "dealer_name": "Dealer A", "dealer_lat": 11, "dealer_lng": 77, "radius_meters": 200, "employee_name": "Arun",
            }
        )
        mock_pool.queue_fetchrow(
            {
                "id": 55, "last_location_status": "inside", "outside_radius_count": 3, "log_out_alert_sent": True,
                "interrupted": True, "should_send_logout_alert": False,
            }
        )
        mock_pool.queue_fetchrow(
            {"id": 9, "left_at": datetime.now(timezone.utc), "alert_count": 2, "max_distance_m": 500}
        )  # open excursion, alerts already fired
        # The claim UPDATE finds status "UPDATE 0" — a concurrent request already
        # closed this excursion (returned_at is no longer NULL).
        mock_pool.queue_execute("UPDATE 0")

        async with rep_client() as c:
            res = await c.post("/api/x/55/location-check", json={"lat": 11, "lng": 77})

        assert res.status_code == 200
        create_manager_notification_mock.assert_not_called()
        assert res.json()["rep_notification"] is None

    async def test_returned_notification_is_sent_when_this_request_wins_the_claim(
        self, mock_pool, create_manager_notification_mock
    ):
        mock_pool.queue_fetchrow(
            {
                "id": 55, "dealer_id": 1, "logout_time": None, "outside_radius_count": 3, "log_out_alert_sent": True,
                "dealer_name": "Dealer A", "dealer_lat": 11, "dealer_lng": 77, "radius_meters": 200, "employee_name": "Arun",
            }
        )
        mock_pool.queue_fetchrow(
            {
                "id": 55, "last_location_status": "inside", "outside_radius_count": 3, "log_out_alert_sent": True,
                "interrupted": True, "should_send_logout_alert": False,
            }
        )
        mock_pool.queue_fetchrow(
            {"id": 9, "left_at": datetime.now(timezone.utc), "alert_count": 2, "max_distance_m": 500}
        )
        mock_pool.queue_execute("UPDATE 1")  # this request wins the claim

        async with rep_client() as c:
            res = await c.post("/api/x/55/location-check", json={"lat": 11, "lng": 77})

        assert res.status_code == 200
        assert create_manager_notification_mock.await_count == 1
        _, kwargs = create_manager_notification_mock.await_args
        assert kwargs["type"] == "returned"
        assert res.json()["rep_notification"]["title"] == "Return inside dealer"


class TestExceptionsManagerOnly:
    async def test_403_for_a_rep(self, mock_pool):
        async with rep_client() as c:
            res = await c.get("/api/x/exceptions")
        assert res.status_code == 403

    async def test_200_for_a_manager(self, mock_pool):
        mock_pool.queue_fetch([])
        async with manager_client() as c:
            res = await c.get("/api/x/exceptions")
        assert res.status_code == 200
        assert res.json()["exceptions"] == []
