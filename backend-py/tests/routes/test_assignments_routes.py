"""Ported from backend/tests/routes/assignments.routes.test.js — same test
intent, same assertions, adapted to FakePool's queue-based mocking (see
tests/helpers/fake_pool.py) in place of Jest's `pool.query.mockResolvedValueOnce`
/ a hand-rolled mockClient() for the PUT route's transactional
pool.connect() usage.

PUT /api/x/ runs inside a transaction via `pool.get_pool().acquire()`, not
module-level `pool.fetch`/`fetchrow`/`execute` directly — the acquired
FakeConnection's own fetch/fetchrow/execute share the SAME ordered queues as
the module-level ones (see fake_pool.py), mirroring how the Node test's
mockClient().query mock is what the route's BEGIN/advisory-lock/DELETE/
INSERT/COMMIT calls hit rather than pool.query.
"""
from datetime import date

import pytest

from app.core.security import Employee
from app.routers import assignments as assignments_router_module
from tests.helpers.test_app import make_client

REP = Employee(id=1, role="rep", username="arun")
MANAGER = Employee(id=99, role="manager", username="priya")


def client_for(employee):
    return make_client(assignments_router_module.router, prefix="/api/x", employee=employee)


class TestGetAssignments:
    async def test_403_when_a_rep_tries_to_list_assignments(self, mock_pool):
        async with client_for(REP) as c:
            res = await c.get("/api/x", params={"employee_id": 5})
        assert res.status_code == 403

    async def test_400_when_employee_id_is_missing(self, mock_pool):
        async with client_for(MANAGER) as c:
            res = await c.get("/api/x")
        assert res.status_code == 400

    async def test_200_lists_a_reps_assignments_ordered_by_sequence(self, mock_pool):
        mock_pool.queue_fetch([{"id": 1, "sequence_order": 1, "dealer_name": "Dealer A"}])
        async with client_for(MANAGER) as c:
            res = await c.get("/api/x", params={"employee_id": REP.id})
        assert res.status_code == 200
        assert len(res.json()["assignments"]) == 1


class TestPutAssignments:
    async def test_403_when_a_rep_tries_to_save_an_assignment(self, mock_pool):
        async with client_for(REP) as c:
            res = await c.put(
                "/api/x",
                json={"employee_id": REP.id, "assignment_date": "2026-08-10", "dealer_ids": [1]},
            )
        assert res.status_code == 403

    async def test_400_when_dealer_ids_is_not_an_array(self, mock_pool):
        async with client_for(MANAGER) as c:
            res = await c.put(
                "/api/x",
                json={"employee_id": REP.id, "assignment_date": "2026-08-10", "dealer_ids": "nope"},
            )
        assert res.status_code == 400

    async def test_404_when_the_representative_does_not_exist(self, mock_pool):
        mock_pool.queue_fetchrow(None)  # employee lookup
        async with client_for(MANAGER) as c:
            res = await c.put(
                "/api/x",
                json={"employee_id": REP.id, "assignment_date": "2026-08-10", "dealer_ids": [1]},
            )
        assert res.status_code == 404
        assert len(mock_pool.released_connections) == 1

    async def test_404_when_one_of_the_dealers_does_not_exist(self, mock_pool):
        mock_pool.queue_fetchrow({"id": REP.id})  # employee exists
        mock_pool.queue_fetch([{"id": 1}])  # only 1 of 2 dealers found
        async with client_for(MANAGER) as c:
            res = await c.put(
                "/api/x",
                json={"employee_id": REP.id, "assignment_date": "2026-08-10", "dealer_ids": [1, 2]},
            )
        assert res.status_code == 404
        assert len(mock_pool.released_connections) == 1

    async def test_200_saves_the_ordered_list_sequence_order_matches_array_order(self, mock_pool):
        mock_pool.queue_fetchrow({"id": REP.id})  # employee exists
        mock_pool.queue_fetch([{"id": 1}, {"id": 2}])  # dealers exist
        mock_pool.queue_execute("UPDATE 1")  # advisory lock
        mock_pool.queue_execute("DELETE 0")  # delete stale
        mock_pool.queue_execute("INSERT 0 1")  # upsert dealer 1
        mock_pool.queue_execute("INSERT 0 1")  # upsert dealer 2
        mock_pool.queue_fetch(
            [
                {"id": 10, "dealer_id": 1, "sequence_order": 1},
                {"id": 11, "dealer_id": 2, "sequence_order": 2},
            ]
        )  # final select

        async with client_for(MANAGER) as c:
            res = await c.put(
                "/api/x",
                json={"employee_id": REP.id, "assignment_date": "2026-08-10", "dealer_ids": [1, 2]},
            )

        assert res.status_code == 200
        assert len(res.json()["assignments"]) == 2
        # Upsert calls (execute_calls[2] and [3] — after the advisory lock and
        # delete) carry sequence_order 1 and 2 respectively. assignment_date is
        # a parsed `date` object here, not the raw string, per assignments.py's
        # _parse_date_param docstring (asyncpg needs a native date, unlike
        # node-pg which hands the raw string straight to Postgres).
        assert mock_pool.execute_calls[2].args == (REP.id, 1, date(2026, 8, 10), 1, MANAGER.id)
        assert mock_pool.execute_calls[3].args == (REP.id, 2, date(2026, 8, 10), 2, MANAGER.id)
        assert len(mock_pool.released_connections) == 1

    async def test_200_clears_the_whole_day_when_dealer_ids_is_empty_without_inserting_anything(self, mock_pool):
        mock_pool.queue_fetchrow({"id": REP.id})  # employee exists
        mock_pool.queue_execute("UPDATE 1")  # advisory lock
        mock_pool.queue_execute("DELETE 3")  # delete everything for that day
        mock_pool.queue_fetch([])  # final select — nothing left

        async with client_for(MANAGER) as c:
            res = await c.put(
                "/api/x",
                json={"employee_id": REP.id, "assignment_date": "2026-08-10", "dealer_ids": []},
            )

        assert res.status_code == 200
        assert res.json()["assignments"] == []
        # No dealer-existence check and no upsert calls when the list is
        # empty — just the employee check (fetchrow), the advisory lock and
        # clearing DELETE (execute x2), and the final re-select (fetch).
        assert len(mock_pool.fetchrow_calls) == 1
        assert len(mock_pool.execute_calls) == 2
        assert len(mock_pool.fetch_calls) == 1
        delete_call = mock_pool.execute_calls[1]
        assert "DELETE FROM dealer_assignments" in delete_call.query
        assert delete_call.args == (REP.id, date(2026, 8, 10), [])


class TestDeleteAssignment:
    async def test_403_when_a_rep_tries_to_delete_an_assignment(self, mock_pool):
        async with client_for(REP) as c:
            res = await c.delete("/api/x/5")
        assert res.status_code == 403

    async def test_404_when_the_assignment_does_not_exist(self, mock_pool):
        mock_pool.queue_fetchrow(None)
        async with client_for(MANAGER) as c:
            res = await c.delete("/api/x/5")
        assert res.status_code == 404

    async def test_200_deletes_the_assignment(self, mock_pool):
        mock_pool.queue_fetchrow({"id": 5})
        mock_pool.queue_execute("DELETE 1")
        async with client_for(MANAGER) as c:
            res = await c.delete("/api/x/5")
        assert res.status_code == 200
        assert res.json()["success"] is True


class TestGetTodayAssignments:
    async def test_200_returns_the_callers_own_assigned_dealers_rep_access_no_manager_role_required(self, mock_pool):
        mock_pool.queue_fetch(
            [{"id": 1, "sequence_order": 1, "dealer_name": "Dealer A", "navigation_status": None}]
        )
        async with client_for(REP) as c:
            res = await c.get("/api/x/today")
        assert res.status_code == 200
        assert len(res.json()["assignments"]) == 1
        assert mock_pool.fetch_calls[0].args == (REP.id,)
