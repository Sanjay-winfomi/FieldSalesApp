"""Ported from backend/tests/routes/notifications.routes.test.js — same test
intent, same assertions, adapted to FakePool's queue-based mocking (see
tests/helpers/fake_pool.py) in place of Jest's `pool.query.mockResolvedValueOnce`.

Statement-kind mapping (see app/routers/notifications.py):
  GET /              -> pool.fetch
  GET /unread-count  -> pool.fetchrow
  POST /read-all     -> pool.execute
  PATCH /:id/read    -> pool.fetchrow
  DELETE /:id        -> pool.fetch (CTE returns rows)
  DELETE /           -> pool.fetch (CTE returns rows)
"""
from app.core.security import Employee
from app.routers import notifications as notifications_router_module
from tests.helpers.test_app import make_client

MANAGER = Employee(id=99, role="manager", username="priya")


def client_for(employee):
    return make_client(notifications_router_module.router, prefix="/api/x", employee=employee)


class TestListNotifications:
    async def test_200_lists_notifications_newest_first(self, mock_pool):
        mock_pool.queue_fetch([{"id": 1, "type": "day_auto_cutoff"}])
        async with client_for(MANAGER) as c:
            res = await c.get("/api/x")
        assert res.status_code == 200
        assert len(res.json()["notifications"]) == 1
        # A soft-dismissed day_absent row must not resurface in the feed.
        sql = mock_pool.fetch_calls[0].query
        assert "n.dismissed_at IS NULL" in sql


class TestUnreadCount:
    async def test_200_returns_the_unread_count(self, mock_pool):
        mock_pool.queue_fetchrow({"count": 3})
        async with client_for(MANAGER) as c:
            res = await c.get("/api/x/unread-count")
        assert res.status_code == 200
        assert res.json()["count"] == 3
        sql = mock_pool.fetchrow_calls[0].query
        assert "dismissed_at IS NULL" in sql


class TestReadAll:
    async def test_marks_everything_read_except_types_requiring_explicit_review(self, mock_pool):
        mock_pool.queue_execute("UPDATE 0")
        async with client_for(MANAGER) as c:
            res = await c.post("/api/x/read-all")
        assert res.status_code == 200
        assert res.json()["success"] is True
        # day_auto_cutoff/visit_auto_cutoff must be excluded — opening the page
        # must not silently mark a missed-logout event read before a manager
        # has actually clicked "Reviewed".
        call = mock_pool.execute_calls[0]
        assert "type != ALL" in call.query
        params0 = call.args[0]
        for t in ("day_auto_cutoff", "visit_auto_cutoff", "day_absent"):
            assert t in params0


class TestMarkRead:
    async def test_400_on_an_invalid_id(self, mock_pool):
        async with client_for(MANAGER) as c:
            res = await c.patch("/api/x/not-a-number/read")
        assert res.status_code == 400

    async def test_404_when_the_notification_does_not_exist(self, mock_pool):
        mock_pool.queue_fetchrow(None)
        async with client_for(MANAGER) as c:
            res = await c.patch("/api/x/20/read")
        assert res.status_code == 404

    async def test_200_marks_a_single_notification_as_reviewed(self, mock_pool):
        mock_pool.queue_fetchrow({"id": 20, "read_at": "2026-08-18T01:00:00Z"})
        async with client_for(MANAGER) as c:
            res = await c.patch("/api/x/20/read")
        assert res.status_code == 200
        assert res.json()["notification"]["read_at"]


class TestDeleteSingle:
    async def test_400_on_an_invalid_id(self, mock_pool):
        async with client_for(MANAGER) as c:
            res = await c.delete("/api/x/not-a-number")
        assert res.status_code == 400

    async def test_200_deletes_a_reviewed_auto_cutoff_notification(self, mock_pool):
        mock_pool.queue_fetch([{"id": 20}])
        async with client_for(MANAGER) as c:
            res = await c.delete("/api/x/20")
        assert res.status_code == 200
        assert res.json()["success"] is True
        # The eligibility rule (reviewed, or an approved/rejected follow-up
        # request) is enforced in the query itself, not just client-side.
        call = mock_pool.fetch_calls[0]
        assert "read_at IS NOT NULL" in call.query
        assert "status IN ('approved', 'rejected')" in call.query
        assert call.args[0] == 20
        for t in ("day_auto_cutoff", "visit_auto_cutoff", "day_absent"):
            assert t in call.args[1]

    # A day_absent row must be soft-dismissed, not hard-deleted — absenceCheck.js
    # re-flags the same employee+business_date on its next 15-minute sweep as
    # soon as no day_absent row for that pair still exists, so an actual DELETE
    # let a reviewed-and-cleared absence notification silently come back as a
    # brand-new, unreviewed one.
    async def test_200_soft_dismisses_a_reviewed_day_absent_notification(self, mock_pool):
        mock_pool.queue_fetch([{"id": 21}])
        async with client_for(MANAGER) as c:
            res = await c.delete("/api/x/21")
        assert res.status_code == 200
        assert res.json()["success"] is True
        sql = mock_pool.fetch_calls[0].query
        assert "UPDATE manager_notifications SET dismissed_at = NOW()" in sql
        assert "WHERE id IN (SELECT id FROM target WHERE type = 'day_absent')" in sql
        assert "DELETE FROM manager_notifications" in sql
        assert "WHERE id IN (SELECT id FROM target WHERE type <> 'day_absent')" in sql

    async def test_404_when_not_found_or_not_yet_reviewed_resolved(self, mock_pool):
        # The query's WHERE clause matches zero rows either way — the route
        # can't (and doesn't need to) distinguish "wrong id" from "not eligible
        # yet" from a single DELETE ... RETURNING result.
        mock_pool.queue_fetch([])
        async with client_for(MANAGER) as c:
            res = await c.delete("/api/x/20")
        assert res.status_code == 404


class TestDeleteBulk:
    async def test_200_deletes_every_currently_eligible_notification_and_reports_count(self, mock_pool):
        mock_pool.queue_fetch([{"id": 20}, {"id": 21}, {"id": 22}])
        async with client_for(MANAGER) as c:
            res = await c.delete("/api/x")
        assert res.status_code == 200
        assert res.json()["success"] is True
        assert res.json()["deleted"] == 3
        # Same eligibility rule as the single-id route, just with no id filter.
        call = mock_pool.fetch_calls[0]
        assert "n.id = $1" not in call.query
        assert "read_at IS NOT NULL" in call.query
        assert "status IN ('approved', 'rejected')" in call.query
        for t in ("day_auto_cutoff", "visit_auto_cutoff", "day_absent"):
            assert t in call.args[0]

    async def test_200_with_deleted_0_when_nothing_is_currently_eligible(self, mock_pool):
        mock_pool.queue_fetch([])
        async with client_for(MANAGER) as c:
            res = await c.delete("/api/x")
        assert res.status_code == 200
        assert res.json()["deleted"] == 0
