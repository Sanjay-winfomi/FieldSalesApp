"""Ported from backend/tests/utils/dealerAssignments.test.js — same test
intent, same assertions, adapted to FakePool's queue-based mocking (see
tests/helpers/fake_pool.py) in place of Jest's `pool.query.mockResolvedValueOnce`.

Note: Node's pool.query() backs every statement (RETURNING UPDATEs, plain
UPDATEs, SELECTs, INSERTs) with one shared mock queue; the Python port splits
these by asyncpg call kind — pool.fetchrow() for a single-row RETURNING
UPDATE or SELECT, pool.fetch() for a multi-row SELECT, pool.execute() for a
statement with no return rows consulted (the navigation UPDATE, and
create_manager_notification's own INSERT) — so assertions below check
mock_pool.fetchrow_calls/fetch_calls/execute_calls individually instead of a
single combined call list/index, but queue results in the same overall order
Node's chained .mockResolvedValueOnce(...) calls represent.

Unlike autoCutoff.test.js/absenceCheck.test.js, this Jest file does NOT mock
managerNotifications — notifyUnvisitedAssignments's createManagerNotification
call is the real one, whose own INSERT hits the same shared pool.query mock
as the third call. Ported the same way: create_manager_notification is left
un-mocked, and its INSERT is queued/asserted via mock_pool.execute_calls."""
import pytest

from app.services.dealer_assignments import mark_assignment_visited, notify_unvisited_assignments


class TestMarkAssignmentVisited:
    async def test_completes_the_assignment_and_closes_out_its_open_navigation_row(self, mock_pool):
        mock_pool.queue_fetchrow({"id": 20})  # assignment UPDATE ... RETURNING id
        mock_pool.queue_execute("UPDATE 0")  # navigation UPDATE

        await mark_assignment_visited(1, 5)

        assert len(mock_pool.fetchrow_calls) == 1
        assert len(mock_pool.execute_calls) == 1
        assert "UPDATE dealer_assignments" in mock_pool.fetchrow_calls[0].query
        assert "UPDATE dealer_navigations" in mock_pool.execute_calls[0].query
        assert "status IN ('navigating', 'arrived')" in mock_pool.execute_calls[0].query
        assert mock_pool.execute_calls[0].args == (20,)

    async def test_only_closes_the_single_most_recent_open_navigation_row_not_every_open_row(self, mock_pool):
        # A rep can leave more than one stale 'navigating'/'arrived' row behind
        # for the same assignment (retried Tap Navigate without cancelling the
        # earlier attempt) — closing all of them to 'completed' would double-
        # count each one's distance/duration in the Daily Travel Summary, so
        # the UPDATE must target exactly one row (the latest) via a subquery.
        mock_pool.queue_fetchrow({"id": 20})
        mock_pool.queue_execute("UPDATE 0")

        await mark_assignment_visited(1, 5)

        nav_update_sql = mock_pool.execute_calls[0].query
        assert "WHERE id = (" in nav_update_sql
        assert "ORDER BY started_at DESC" in nav_update_sql
        assert "LIMIT 1" in nav_update_sql

    async def test_does_nothing_further_when_the_dealer_has_no_assignment_for_today(self, mock_pool):
        mock_pool.queue_fetchrow(None)  # no matching assignment row

        await mark_assignment_visited(1, 5)

        assert len(mock_pool.fetchrow_calls) == 1
        assert len(mock_pool.execute_calls) == 0  # no navigation UPDATE attempted

    async def test_never_throws_when_the_database_call_fails(self, mock_pool):
        mock_pool.queue_fetchrow(Exception("db down"))

        # should not raise
        result = await mark_assignment_visited(1, 5)
        assert result is None


class TestNotifyUnvisitedAssignments:
    async def test_does_nothing_when_every_assigned_dealer_was_completed_or_cancelled(self, mock_pool):
        mock_pool.queue_fetch([])  # no unvisited dealers

        await notify_unvisited_assignments(1)

        assert len(mock_pool.fetch_calls) == 1
        assert len(mock_pool.fetchrow_calls) == 0  # no username lookup
        assert len(mock_pool.execute_calls) == 0  # no notification insert

    async def test_notifies_managers_naming_the_one_dealer_when_exactly_one_was_not_visited(self, mock_pool):
        mock_pool.queue_fetch([{"dealer_name": "LuLu Hypermarket"}])
        mock_pool.queue_fetchrow({"username": "arun"})
        mock_pool.queue_execute("UPDATE 0")  # createManagerNotification's INSERT

        await notify_unvisited_assignments(1)

        assert len(mock_pool.execute_calls) == 1
        insert_call = mock_pool.execute_calls[0]
        assert "INSERT INTO manager_notifications" in insert_call.query
        assert insert_call.args[0] == "unvisited_assignments"
        assert insert_call.args[2] == "arun ended the day without visiting LuLu Hypermarket."
        assert insert_call.args[4] == 1

    async def test_lists_every_dealer_by_name_when_more_than_one_was_not_visited(self, mock_pool):
        mock_pool.queue_fetch([{"dealer_name": "Boomerang"}, {"dealer_name": "Brookfields Mall"}])
        mock_pool.queue_fetchrow({"username": "arun"})
        mock_pool.queue_execute("UPDATE 0")

        await notify_unvisited_assignments(1)

        insert_call = mock_pool.execute_calls[0]
        assert insert_call.args[2] == (
            "arun ended the day without visiting 2 assigned dealers: Boomerang, Brookfields Mall."
        )

    async def test_never_throws_when_the_database_call_fails(self, mock_pool):
        mock_pool.queue_fetch(Exception("db down"))

        # should not raise
        result = await notify_unvisited_assignments(1)
        assert result is None
