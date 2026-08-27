"""Ported from backend/tests/routes/syncFailures.routes.test.js — same test
intent, same assertions, adapted to FakePool's queue-based mocking (see
tests/helpers/fake_pool.py) in place of Jest's `pool.query.mockResolvedValueOnce`.

The Python route (app/routers/sync_failures.py) makes at most two DB calls,
in order:
  1. pool.fetchrow(...) — the dedup check (SELECT ... LIMIT 1)
  2. pool.execute(...) — the manager-notification INSERT, done inside
     app/services/manager_notifications.py's create_manager_notification()
Jest's single `pool.query` queue is split across these two FakePool queues.
"""
import pytest

from app.core.security import Employee
from app.routers import sync_failures as sync_failures_router_module
from tests.helpers.test_app import make_client

REP = Employee(id=1, role="rep", username="arun")


@pytest.fixture
def client():
    return make_client(sync_failures_router_module.router, prefix="/api/x", employee=REP)


class TestCreateSyncFailure:
    async def test_400_when_url_is_missing(self, client, mock_pool):
        async with client as c:
            res = await c.post("/api/x", json={"method": "post"})
        assert res.status_code == 400

    async def test_201_creates_a_manager_notification_when_no_recent_duplicate_exists(self, client, mock_pool):
        mock_pool.queue_fetchrow(None)  # dedup check: none found
        mock_pool.queue_execute("INSERT 0 1")  # insert
        async with client as c:
            res = await c.post("/api/x", json={"method": "post", "url": "/notes", "error": "timeout"})

        assert res.status_code == 201
        assert res.json()["success"] is True
        assert len(mock_pool.fetchrow_calls) == 1
        assert len(mock_pool.execute_calls) == 1
        insert_call = mock_pool.execute_calls[0]
        assert "INSERT INTO manager_notifications" in insert_call.query
        assert insert_call.args[0] == "sync_failure"
        assert insert_call.args[4] == REP.id

    async def test_201_without_a_second_insert_when_a_recent_duplicate_already_exists_for_this_employee_endpoint(
        self, client, mock_pool
    ):
        mock_pool.queue_fetchrow({"?column?": 1})  # dedup check: found one
        async with client as c:
            res = await c.post("/api/x", json={"method": "post", "url": "/notes", "error": "timeout"})

        assert res.status_code == 201
        assert res.json()["deduped"] is True
        assert len(mock_pool.fetchrow_calls) == 1  # only the dedup check, no insert
        assert len(mock_pool.execute_calls) == 0

    async def test_500_when_the_dedup_check_itself_fails(self, client, mock_pool):
        mock_pool.queue_fetchrow(Exception("db down"))
        async with client as c:
            res = await c.post("/api/x", json={"method": "post", "url": "/notes"})
        assert res.status_code == 500

    async def test_escapes_like_metacharacters_in_the_url_before_building_the_dedup_pattern(self, client, mock_pool):
        mock_pool.queue_fetchrow(None)  # dedup check: none found
        mock_pool.queue_execute("INSERT 0 1")  # insert
        # A literal "%" or "_" in the url must not act as a LIKE wildcard — it
        # should be escaped so the dedup pattern matches this exact url only.
        async with client as c:
            res = await c.post(
                "/api/x", json={"method": "post", "url": "/notes?q=100%_off", "error": "timeout"}
            )

        assert res.status_code == 201
        dedup_call = mock_pool.fetchrow_calls[0]
        assert "ESCAPE '\\'" in dedup_call.query
        assert dedup_call.args[1] == "%POST /notes?q=100\\%\\_off%"
