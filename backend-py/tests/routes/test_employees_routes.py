"""Ported from backend/tests/routes/employees.routes.test.js — same test
intent, same assertions, adapted to FakePool's queue-based mocking (see
tests/helpers/fake_pool.py) in place of Jest's `pool.query.mockResolvedValueOnce`.

Node's employees.routes.js issues each existing-check/insert/delete/update
via `pool.query(...)`, a single generic method returning `{ rows: [...] }`.
The FastAPI port's app/routers/employees.py uses `pool.fetchrow(...)` for
every one of these calls (each expects/returns at most one row), so every
`pool.query.mockResolvedValueOnce({ rows: [...] })` below becomes a single
`mock_pool.queue_fetchrow(...)`.
"""
import pytest

from app.core.security import Employee
from app.routers import employees as employees_router_module
from tests.helpers.test_app import make_client

MANAGER = Employee(id=2, role="manager", username="priya")


@pytest.fixture
def client():
    return make_client(employees_router_module.router, prefix="/api/x", employee=MANAGER)


class TestCreateEmployee:
    async def test_400_when_required_fields_missing(self, client, mock_pool):
        async with client as c:
            res = await c.post("/api/x", json={"name": "New Rep"})
        assert res.status_code == 400

    async def test_400_when_role_isnt_rep_or_manager(self, client, mock_pool):
        async with client as c:
            res = await c.post(
                "/api/x",
                json={"name": "X", "username": "x", "password": "password1", "role": "admin"},
            )
        assert res.status_code == 400

    async def test_400_when_password_too_short(self, client, mock_pool):
        async with client as c:
            res = await c.post(
                "/api/x",
                json={"name": "X", "username": "x", "password": "123", "role": "rep"},
            )
        assert res.status_code == 400

    async def test_409_when_username_already_exists(self, client, mock_pool):
        mock_pool.queue_fetchrow({"id": 1})
        async with client as c:
            res = await c.post(
                "/api/x",
                json={"name": "X", "username": "arun", "password": "password1", "role": "rep"},
            )
        assert res.status_code == 409

    async def test_201_creates_a_new_employee(self, client, mock_pool):
        mock_pool.queue_fetchrow(None)  # existing check
        mock_pool.queue_fetchrow(
            {"id": 3, "name": "New Rep", "username": "new.rep", "role": "rep"}
        )  # insert
        async with client as c:
            res = await c.post(
                "/api/x",
                json={"name": "New Rep", "username": "new.rep", "password": "password1", "role": "rep"},
            )
        assert res.status_code == 201
        assert res.json()["employee"]["username"] == "new.rep"


class TestDeleteEmployee:
    async def test_400_when_trying_to_delete_your_own_account(self, client, mock_pool):
        async with client as c:
            res = await c.delete(f"/api/x/{MANAGER.id}")
        assert res.status_code == 400
        assert mock_pool.fetch_calls == []
        assert mock_pool.fetchrow_calls == []
        assert mock_pool.execute_calls == []

    async def test_404_when_the_employee_does_not_exist(self, client, mock_pool):
        mock_pool.queue_fetchrow(None)
        async with client as c:
            res = await c.delete("/api/x/999")
        assert res.status_code == 404

    async def test_200_deletes_an_existing_employee(self, client, mock_pool):
        mock_pool.queue_fetchrow({"id": 5})
        async with client as c:
            res = await c.delete("/api/x/5")
        assert res.status_code == 200
        assert res.json()["success"] is True


class TestResetPassword:
    async def test_400_when_password_too_short(self, client, mock_pool):
        async with client as c:
            res = await c.post("/api/x/3/reset-password", json={"password": "123"})
        assert res.status_code == 400

    async def test_404_when_the_employee_does_not_exist(self, client, mock_pool):
        mock_pool.queue_fetchrow(None)
        async with client as c:
            res = await c.post("/api/x/999/reset-password", json={"password": "newpassword1"})
        assert res.status_code == 404

    async def test_200_on_success(self, client, mock_pool):
        mock_pool.queue_fetchrow({"id": 3})
        async with client as c:
            res = await c.post("/api/x/3/reset-password", json={"password": "newpassword1"})
        assert res.status_code == 200
        assert res.json()["success"] is True
