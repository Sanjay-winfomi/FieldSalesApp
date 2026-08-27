"""Ported from backend/tests/routes/notes.routes.test.js — same test intent,
same assertions, adapted to FakePool's queue-based mocking (see
tests/helpers/fake_pool.py) in place of Jest's `pool.query.mockResolvedValueOnce`.

The Python route uses asyncpg's fetch/fetchrow/execute instead of node-pg's
single pool.query(), so each Jest `pool.query.mockResolvedValueOnce({ rows: [...] })`
maps to a `mock_pool.queue_fetch(...)`/`queue_fetchrow(...)` call matching
whichever method the route actually calls for that statement (see notes.py)."""
import pytest

from app.core.security import Employee
from app.routers import notes as notes_router_module
from tests.helpers.test_app import make_client

REP = Employee(id=1, role="rep", username="arun")
OTHER_REP = Employee(id=2, role="rep", username="divya")
MANAGER = Employee(id=99, role="manager", username="priya")

LONG_CONTENT = "a" * 100
SHORT_CONTENT = "too short"


def client_for(employee):
    return make_client(notes_router_module.router, prefix="/api/x", employee=employee)


class TestCreateNote:
    async def test_422_when_content_is_under_100_characters(self, mock_pool):
        async with client_for(REP) as c:
            res = await c.post("/api/x", json={"content": SHORT_CONTENT})
        assert res.status_code == 422
        assert res.json()["error"] == "content_too_short"

    async def test_422_when_content_is_missing(self, mock_pool):
        async with client_for(REP) as c:
            res = await c.post("/api/x", json={})
        assert res.status_code == 422

    async def test_201_creates_a_note_for_the_authenticated_employee(self, mock_pool):
        mock_pool.queue_fetchrow({"id": 5, "employee_id": REP.id, "content": LONG_CONTENT})
        async with client_for(REP) as c:
            res = await c.post("/api/x", json={"content": LONG_CONTENT})
        assert res.status_code == 201
        assert res.json()["note"]["id"] == 5
        assert mock_pool.fetchrow_calls[0].args == (REP.id, LONG_CONTENT)


class TestListNotes:
    async def test_200_lists_the_callers_own_notes(self, mock_pool):
        mock_pool.queue_fetch([{"id": 1, "employee_id": REP.id, "content": LONG_CONTENT}])
        async with client_for(REP) as c:
            res = await c.get("/api/x")
        assert res.status_code == 200
        assert len(res.json()["notes"]) == 1
        assert mock_pool.fetch_calls[0].args == (REP.id,)

    async def test_manager_can_pass_employee_id_to_view_a_reps_notes(self, mock_pool):
        mock_pool.queue_fetch([])
        async with client_for(MANAGER) as c:
            res = await c.get("/api/x", params={"employee_id": REP.id})
        assert res.status_code == 200
        assert mock_pool.fetch_calls[0].args == (REP.id,)


class TestGetNote:
    async def test_404_when_note_does_not_exist(self, mock_pool):
        mock_pool.queue_fetchrow(None)
        async with client_for(REP) as c:
            res = await c.get("/api/x/5")
        assert res.status_code == 404

    async def test_403_when_a_rep_requests_another_reps_note(self, mock_pool):
        mock_pool.queue_fetchrow({"id": 5, "employee_id": OTHER_REP.id, "content": LONG_CONTENT})
        async with client_for(REP) as c:
            res = await c.get("/api/x/5")
        assert res.status_code == 403

    async def test_200_when_a_manager_requests_any_note(self, mock_pool):
        mock_pool.queue_fetchrow({"id": 5, "employee_id": REP.id, "content": LONG_CONTENT})
        async with client_for(MANAGER) as c:
            res = await c.get("/api/x/5")
        assert res.status_code == 200


class TestUpdateNote:
    async def test_422_when_new_content_is_under_100_characters(self, mock_pool):
        async with client_for(REP) as c:
            res = await c.put("/api/x/5", json={"content": SHORT_CONTENT})
        assert res.status_code == 422

    async def test_404_when_note_does_not_exist(self, mock_pool):
        mock_pool.queue_fetchrow(None)
        async with client_for(REP) as c:
            res = await c.put("/api/x/5", json={"content": LONG_CONTENT})
        assert res.status_code == 404

    async def test_403_when_a_rep_edits_another_reps_note(self, mock_pool):
        mock_pool.queue_fetchrow({"employee_id": OTHER_REP.id})
        async with client_for(REP) as c:
            res = await c.put("/api/x/5", json={"content": LONG_CONTENT})
        assert res.status_code == 403

    async def test_200_updates_the_note_content(self, mock_pool):
        mock_pool.queue_fetchrow({"employee_id": REP.id})
        mock_pool.queue_fetchrow({"id": 5, "employee_id": REP.id, "content": LONG_CONTENT})
        async with client_for(REP) as c:
            res = await c.put("/api/x/5", json={"content": LONG_CONTENT})
        assert res.status_code == 200
        assert res.json()["note"]["content"] == LONG_CONTENT


class TestDeleteNote:
    async def test_404_when_note_does_not_exist(self, mock_pool):
        mock_pool.queue_fetchrow(None)
        async with client_for(REP) as c:
            res = await c.delete("/api/x/5")
        assert res.status_code == 404

    async def test_403_when_a_rep_deletes_another_reps_note(self, mock_pool):
        mock_pool.queue_fetchrow({"employee_id": OTHER_REP.id})
        async with client_for(REP) as c:
            res = await c.delete("/api/x/5")
        assert res.status_code == 403

    async def test_200_deletes_the_note(self, mock_pool):
        mock_pool.queue_fetchrow({"employee_id": REP.id})
        mock_pool.queue_execute("DELETE 1")
        async with client_for(REP) as c:
            res = await c.delete("/api/x/5")
        assert res.status_code == 200
        assert res.json()["success"] is True
