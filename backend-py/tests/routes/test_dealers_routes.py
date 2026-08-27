"""Ported from backend/tests/routes/dealers.routes.test.js — same test intent,
same assertions, adapted to FakePool's queue-based mocking (see
tests/helpers/fake_pool.py) in place of Jest's `pool.query.mockResolvedValueOnce`
/ the DELETE route's `pool.connect()`-backed transactional client mock.

DELETE /api/x/:id runs its reads + delete inside a transaction via
pool.get_pool().acquire() — FakeConnection's fetch/fetchrow/execute share the
FakePool's own queues (see fake_pool.py), so conn.* calls are queued exactly
like module-level pool.* calls, just with no queued value for BEGIN/COMMIT/
ROLLBACK since those are structural (FakeTransaction.start()/commit()/
rollback()), not queued DB calls.
"""
from unittest.mock import AsyncMock

import pytest

from app.core.security import Employee
from app.routers import dealers as dealers_router_module
from tests.helpers.test_app import make_client

REP = Employee(id=1, role="rep", username="arun")
MANAGER = Employee(id=2, role="manager", username="priya")


@pytest.fixture(autouse=True)
def _fake_manager_notifications(monkeypatch):
    # Mirrors the task brief: dealers.py imports create_manager_notification
    # from app.services.manager_notifications and calls it by that name inside
    # app.routers.dealers, so patch it there (where it's looked up at call
    # time). None of the tests below exercise the pending-work branch (the
    # "affected rows" query always comes back empty), so this never actually
    # fires, but it's patched defensively so a real DB call never sneaks in.
    mock = AsyncMock()
    monkeypatch.setattr(dealers_router_module, "create_manager_notification", mock)
    return mock


def client_for(employee):
    return make_client(dealers_router_module.router, prefix="/api/x", employee=employee)


class TestListDealers:
    async def test_200_lists_dealers(self, mock_pool):
        mock_pool.queue_fetch([{"id": 1, "name": "Dealer A"}])
        client = client_for(REP)
        async with client as c:
            res = await c.get("/api/x")
        assert res.status_code == 200
        assert len(res.json()["dealers"]) == 1

    async def test_escapes_like_metacharacters_in_search(self, mock_pool):
        mock_pool.queue_fetch([])
        client = client_for(REP)
        async with client as c:
            await c.get("/api/x", params={"search": "100% Fresh_Mart"})
        call = mock_pool.fetch_calls[0]
        assert call.args[0] == "%100\\% Fresh\\_Mart%"


class TestCreateDealerManagerOnly:
    async def test_403_for_a_rep(self, mock_pool):
        client = client_for(REP)
        async with client as c:
            res = await c.post("/api/x", json={"name": "New Dealer"})
        assert res.status_code == 403

    async def test_400_when_name_missing(self, mock_pool):
        client = client_for(MANAGER)
        async with client as c:
            res = await c.post("/api/x", json={})
        assert res.status_code == 400

    async def test_201_creates_a_dealer_with_default_radius(self, mock_pool):
        mock_pool.queue_fetchrow({"id": 10, "name": "New Dealer", "radius_meters": 200})
        client = client_for(MANAGER)
        async with client as c:
            res = await c.post("/api/x", json={"name": "New Dealer"})
        assert res.status_code == 201
        assert res.json()["dealer"]["radius_meters"] == 200


class TestUpdateDealerManagerOnly:
    async def test_404_when_dealer_does_not_exist(self, mock_pool):
        mock_pool.queue_fetchrow(None)
        client = client_for(MANAGER)
        async with client as c:
            res = await c.put("/api/x/999", json={"name": "X"})
        assert res.status_code == 404


class TestDeleteDealerManagerOnly:
    async def test_403_for_a_rep(self, mock_pool):
        client = client_for(REP)
        async with client as c:
            res = await c.delete("/api/x/1")
        assert res.status_code == 403

    async def test_404_when_dealer_does_not_exist(self, mock_pool):
        mock_pool.queue_fetchrow(None)  # existence check (FOR UPDATE)
        client = client_for(MANAGER)
        async with client as c:
            res = await c.delete("/api/x/999")
        assert res.status_code == 404
        assert len(mock_pool.released_connections) == 1

    # Deletion now cascades (schema.sql) instead of being blocked — deleting a
    # dealer with recorded visits succeeds and permanently removes that
    # history too; deletedVisitCount just reports what was removed.
    async def test_200_deletes_a_dealer_with_recorded_visits_cascading_to_its_history(self, mock_pool):
        mock_pool.queue_fetchrow({"id": 1})  # existence check
        mock_pool.queue_fetchrow({"count": 3})  # visit count
        mock_pool.queue_fetch([])  # affected follow-ups/assignments
        mock_pool.queue_execute("DELETE 1")  # delete
        client = client_for(MANAGER)
        async with client as c:
            res = await c.delete("/api/x/1")
        assert res.status_code == 200
        body = res.json()
        assert body["success"] is True
        assert body["deletedVisitCount"] == 3
        assert len(mock_pool.released_connections) == 1

    async def test_200_deletes_a_dealer_with_no_recorded_visits(self, mock_pool):
        mock_pool.queue_fetchrow({"id": 1})  # existence check
        mock_pool.queue_fetchrow({"count": 0})  # visit count
        mock_pool.queue_fetch([])  # affected follow-ups/assignments
        mock_pool.queue_execute("DELETE 1")  # delete
        client = client_for(MANAGER)
        async with client as c:
            res = await c.delete("/api/x/1")
        assert res.status_code == 200
        body = res.json()
        assert body["success"] is True
        assert body["deletedVisitCount"] == 0
