"""Ported from backend/tests/routes/navigation.routes.test.js — same test
intent, same assertions, adapted to FakePool's queue-based mocking (see
tests/helpers/fake_pool.py) in place of Jest's `pool.query.mockResolvedValueOnce`
chaining, and to monkeypatching `app.routers.navigation.compute_route` (an
AsyncMock) in place of Jest's `jest.mock('../../src/services/googleRoutesService', ...)`."""
import json
from unittest.mock import AsyncMock

import pytest

from app.core.security import Employee
from app.routers import navigation as navigation_module
from app.services.google_routes import RouteResult, RoutesApiError
from tests.helpers.test_app import make_client

REP = Employee(id=1, role="rep", username="arun")
OTHER_REP = Employee(id=2, role="rep", username="divya")
MANAGER = Employee(id=99, role="manager", username="priya")


def make_nav_client(employee):
    return make_client(navigation_module.router, prefix="/api/x", employee=employee)


@pytest.fixture
def compute_route_mock(monkeypatch):
    mock = AsyncMock()
    monkeypatch.setattr(navigation_module, "compute_route", mock)
    return mock


class TestComputeCompute:
    """POST /api/x/compute"""

    async def test_400_when_dealer_id_is_missing(self, mock_pool):
        client = make_nav_client(REP)
        async with client as c:
            res = await c.post("/api/x/compute", json={"origin_lat": 1, "origin_lng": 2})
        assert res.status_code == 400

    async def test_404_when_the_dealer_does_not_exist(self, mock_pool):
        mock_pool.queue_fetchrow(None)
        client = make_nav_client(REP)
        async with client as c:
            res = await c.post("/api/x/compute", json={"dealer_id": 5, "origin_lat": 1, "origin_lng": 2})
        assert res.status_code == 404

    async def test_422_when_the_dealer_has_no_coordinates(self, mock_pool):
        mock_pool.queue_fetchrow({"id": 5, "name": "Dealer A", "latitude": None, "longitude": None})
        client = make_nav_client(REP)
        async with client as c:
            res = await c.post("/api/x/compute", json={"dealer_id": 5, "origin_lat": 1, "origin_lng": 2})
        assert res.status_code == 422
        assert res.json()["error"] == "dealer_missing_coordinates"

    async def test_502_when_the_routes_api_call_fails(self, mock_pool, compute_route_mock):
        mock_pool.queue_fetchrow({"id": 5, "name": "Dealer A", "latitude": 13, "longitude": 77})
        compute_route_mock.side_effect = RoutesApiError("upstream failed")
        client = make_nav_client(REP)
        async with client as c:
            res = await c.post("/api/x/compute", json={"dealer_id": 5, "origin_lat": 1, "origin_lng": 2})
        assert res.status_code == 502
        body = res.json()
        assert body["error"] == "route_computation_failed"
        assert body["message"] == "Request timed out — Retry"

    async def test_201_creates_a_navigation_record_and_marks_the_assignment_navigating(self, mock_pool, compute_route_mock):
        mock_pool.queue_fetchrow({"id": 5, "name": "Dealer A", "latitude": 13, "longitude": 77})  # dealer lookup
        mock_pool.queue_fetchrow({"id": 20})  # assignment ownership check
        mock_pool.queue_fetchrow({"id": 100, "status": "navigating", "distance_meters": 500})  # insert navigation
        mock_pool.queue_execute("UPDATE 1")  # update assignment status
        compute_route_mock.return_value = RouteResult(
            distance_meters=500, duration_seconds=60, duration_in_traffic_seconds=70,
            static_duration_seconds=55, encoded_polyline="xyz",
        )

        client = make_nav_client(REP)
        async with client as c:
            res = await c.post(
                "/api/x/compute",
                json={"dealer_id": 5, "assignment_id": 20, "origin_lat": 1, "origin_lng": 2},
            )

        assert res.status_code == 201
        assert res.json()["navigation"]["id"] == 100
        assert "UPDATE dealer_assignments" in mock_pool.execute_calls[0].query

    async def test_a_retried_request_with_the_same_idempotency_key_replays_the_cached_response(self, mock_pool, compute_route_mock):
        mock_pool.queue_fetchrow({
            "response_status": 201,
            "response_body": json.dumps({"navigation": {"id": 100, "status": "navigating"}}),
        })

        client = make_nav_client(REP)
        async with client as c:
            res = await c.post(
                "/api/x/compute",
                headers={"Idempotency-Key": "retry-key-1"},
                json={"dealer_id": 5, "origin_lat": 1, "origin_lng": 2},
            )

        assert res.status_code == 201
        assert res.json()["navigation"]["id"] == 100
        # Only the idempotency lookup ran — no dealer lookup, no second
        # computeRoute call, no second insert.
        assert len(mock_pool.fetchrow_calls) == 1
        assert len(mock_pool.fetch_calls) == 0
        assert len(mock_pool.execute_calls) == 0
        compute_route_mock.assert_not_called()


class TestDistancePreview:
    """POST /api/x/distance-preview"""

    async def test_400_when_coordinates_are_missing_invalid(self, mock_pool):
        client = make_nav_client(REP)
        async with client as c:
            res = await c.post("/api/x/distance-preview", json={"origin_lat": 1, "origin_lng": 2})
        assert res.status_code == 400

    async def test_200_returns_distance_duration_with_no_db_writes_at_all(self, mock_pool, compute_route_mock):
        compute_route_mock.return_value = RouteResult(
            distance_meters=5200, duration_seconds=600, duration_in_traffic_seconds=720,
            static_duration_seconds=None, encoded_polyline="xyz",
        )
        client = make_nav_client(REP)
        async with client as c:
            res = await c.post(
                "/api/x/distance-preview",
                json={"origin_lat": 11, "origin_lng": 77, "dest_lat": 11.02, "dest_lng": 77.01},
            )

        assert res.status_code == 200
        assert res.json() == {"distanceMeters": 5200, "durationSeconds": 600, "durationInTrafficSeconds": 720}
        assert len(mock_pool.fetch_calls) == 0
        assert len(mock_pool.fetchrow_calls) == 0
        assert len(mock_pool.execute_calls) == 0

    async def test_a_manager_can_also_call_this(self, mock_pool, compute_route_mock):
        compute_route_mock.return_value = RouteResult(
            distance_meters=100, duration_seconds=60, duration_in_traffic_seconds=60,
            static_duration_seconds=None, encoded_polyline=None,
        )
        client = make_nav_client(MANAGER)
        async with client as c:
            res = await c.post(
                "/api/x/distance-preview",
                json={"origin_lat": 11, "origin_lng": 77, "dest_lat": 11.001, "dest_lng": 77.001},
            )
        assert res.status_code == 200

    async def test_502_when_the_routes_api_call_fails(self, mock_pool, compute_route_mock):
        compute_route_mock.side_effect = RoutesApiError("upstream failed")
        client = make_nav_client(REP)
        async with client as c:
            res = await c.post(
                "/api/x/distance-preview",
                json={"origin_lat": 11, "origin_lng": 77, "dest_lat": 11.02, "dest_lng": 77.01},
            )
        assert res.status_code == 502
        body = res.json()
        assert body["error"] == "route_computation_failed"
        assert body["message"] == "Request timed out — Retry"


class TestPatchStatus:
    """PATCH /api/x/:id/status"""

    async def test_400_when_status_is_invalid(self, mock_pool):
        client = make_nav_client(REP)
        async with client as c:
            res = await c.patch("/api/x/100/status", json={"status": "flying"})
        assert res.status_code == 400

    async def test_404_when_the_navigation_does_not_exist(self, mock_pool):
        mock_pool.queue_fetchrow(None)
        client = make_nav_client(REP)
        async with client as c:
            res = await c.patch("/api/x/100/status", json={"status": "arrived"})
        assert res.status_code == 404

    async def test_403_when_a_rep_updates_another_reps_navigation(self, mock_pool):
        mock_pool.queue_fetchrow({"id": 100, "employee_id": OTHER_REP.id, "assignment_id": None})
        client = make_nav_client(REP)
        async with client as c:
            res = await c.patch("/api/x/100/status", json={"status": "arrived"})
        assert res.status_code == 403

    async def test_200_updates_status_and_mirrors_onto_the_linked_assignment(self, mock_pool):
        mock_pool.queue_fetchrow({"id": 100, "employee_id": REP.id, "assignment_id": 20})
        mock_pool.queue_fetchrow({"id": 100, "status": "completed", "ended_at": "2026-08-10T10:00:00Z"})
        mock_pool.queue_execute("UPDATE 1")

        client = make_nav_client(REP)
        async with client as c:
            res = await c.patch("/api/x/100/status", json={"status": "completed"})

        assert res.status_code == 200
        assert res.json()["navigation"]["status"] == "completed"
        assert "UPDATE dealer_assignments" in mock_pool.execute_calls[0].query

    async def test_does_not_mirror_a_cancelled_navigation_onto_the_assignment(self, mock_pool):
        mock_pool.queue_fetchrow({"id": 100, "employee_id": REP.id, "assignment_id": 20})
        mock_pool.queue_fetchrow({"id": 100, "status": "cancelled", "ended_at": "2026-08-10T10:00:00Z"})

        client = make_nav_client(REP)
        async with client as c:
            res = await c.patch("/api/x/100/status", json={"status": "cancelled"})

        assert res.status_code == 200
        assert len(mock_pool.fetchrow_calls) == 2
        assert len(mock_pool.execute_calls) == 0  # no third call updating dealer_assignments

    async def test_a_late_arrived_cannot_regress_an_already_completed_assignment(self, mock_pool):
        mock_pool.queue_fetchrow({"id": 101, "employee_id": REP.id, "assignment_id": 21})
        mock_pool.queue_fetchrow({"id": 101, "status": "arrived", "ended_at": None})
        mock_pool.queue_execute("UPDATE 0")  # WHERE clause excludes the row (rank guard), 0 rows affected

        client = make_nav_client(REP)
        async with client as c:
            res = await c.patch("/api/x/101/status", json={"status": "arrived"})

        assert res.status_code == 200
        assert len(mock_pool.fetchrow_calls) == 2
        assert len(mock_pool.execute_calls) == 1
        assignment_update_sql = mock_pool.execute_calls[0].query
        assert "CASE status" in assignment_update_sql
        assert "CASE $1" in assignment_update_sql

    async def test_a_late_arrived_cannot_resurrect_a_cancelled_assignment(self, mock_pool):
        # 'cancelled' and 'pending' share rank 0 in the CASE expression — the
        # explicit `status != 'cancelled'` guard is what actually stops this,
        # not the rank comparison alone.
        mock_pool.queue_fetchrow({"id": 102, "employee_id": REP.id, "assignment_id": 22})
        mock_pool.queue_fetchrow({"id": 102, "status": "arrived", "ended_at": None})
        mock_pool.queue_execute("UPDATE 0")  # status != 'cancelled' excludes the row, 0 rows affected

        client = make_nav_client(REP)
        async with client as c:
            res = await c.patch("/api/x/102/status", json={"status": "arrived"})

        assert res.status_code == 200
        assert "status != 'cancelled'" in mock_pool.execute_calls[0].query


class TestHistory:
    """GET /api/x/history"""

    async def test_403_when_a_rep_requests_history(self, mock_pool):
        client = make_nav_client(REP)
        async with client as c:
            res = await c.get("/api/x/history")
        assert res.status_code == 403

    async def test_200_returns_paginated_history(self, mock_pool):
        mock_pool.queue_fetchrow({"total": 45})
        mock_pool.queue_fetch([{"id": 1}, {"id": 2}])

        client = make_nav_client(MANAGER)
        async with client as c:
            res = await c.get("/api/x/history", params={"page": 2, "limit": 20})

        assert res.status_code == 200
        body = res.json()
        assert body["total"] == 45
        assert body["page"] == 2
        assert body["pageCount"] == 3
        assert len(body["navigations"]) == 2


class TestSummaryToday:
    """GET /api/x/summary/today"""

    async def test_200_returns_the_callers_daily_travel_summary(self, mock_pool):
        mock_pool.queue_fetchrow({"total_assigned": 4, "visited": 2, "pending": 2})
        mock_pool.queue_fetchrow({
            "distance_travelled_m": 3000, "remaining_distance_m": 5000,
            "driving_time_completed_s": 600, "estimated_remaining_time_s": 900,
        })

        client = make_nav_client(REP)
        async with client as c:
            res = await c.get("/api/x/summary/today")

        assert res.status_code == 200
        body = res.json()
        assert body["total_assigned_dealers"] == 4
        assert body["visited_dealers"] == 2
        assert body["pending_dealers"] == 2
        assert body["total_planned_distance_m"] == 8000
        assert body["distance_travelled_m"] == 3000
