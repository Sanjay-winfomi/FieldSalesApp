"""Ported from backend/tests/routes/auth.routes.test.js — same test intent,
same assertions, adapted to FakePool's queue-based mocking (see
tests/helpers/fake_pool.py) in place of Jest's `pool.query.mockResolvedValueOnce`."""
import bcrypt
import jwt as pyjwt
import pytest

from app.core.config import JWT_SECRET
from app.routers import auth as auth_router_module
from tests.helpers.test_app import make_client


@pytest.fixture
def client():
    return make_client(auth_router_module.router, prefix="/api/auth")


class TestLogin:
    async def test_400_when_username_password_missing(self, client, mock_pool):
        async with client as c:
            res = await c.post("/api/auth/login", json={"username": "arun"})
        assert res.status_code == 400

    async def test_401_generic_message_when_username_not_found(self, client, mock_pool):
        mock_pool.queue_fetchrow(None)
        async with client as c:
            res = await c.post("/api/auth/login", json={"username": "nobody", "password": "x"})
        assert res.status_code == 401
        assert res.json()["error"] == "Username not found"

    async def test_401_when_employee_deactivated(self, client, mock_pool):
        mock_pool.queue_fetchrow({"id": 1, "is_active": False, "password_hash": "x"})
        async with client as c:
            res = await c.post("/api/auth/login", json={"username": "arun", "password": "x"})
        assert res.status_code == 401
        assert res.json()["error"] == "Username not found"

    async def test_401_on_wrong_password(self, client, mock_pool):
        pw_hash = bcrypt.hashpw(b"correct-password", bcrypt.gensalt(10)).decode()
        mock_pool.queue_fetchrow({"id": 1, "is_active": True, "password_hash": pw_hash, "role": "rep"})
        async with client as c:
            res = await c.post("/api/auth/login", json={"username": "arun", "password": "wrong"})
        assert res.status_code == 401
        assert res.json()["error"] == "Incorrect password"

    async def test_200_with_tokens_on_success(self, client, mock_pool):
        pw_hash = bcrypt.hashpw(b"correct-password", bcrypt.gensalt(10)).decode()
        mock_pool.queue_fetchrow({
            "id": 1, "name": "Arun Kumar", "username": "arun.kumar", "password_hash": pw_hash,
            "role": "rep", "region": "South", "is_active": True,
        })
        async with client as c:
            res = await c.post("/api/auth/login", json={"username": "arun.kumar", "password": "correct-password"})
        assert res.status_code == 200
        body = res.json()
        assert body["accessToken"]
        assert body["refreshToken"]
        assert body["employee"]["username"] == "arun.kumar"
        assert "password_hash" not in body["employee"]


class TestRefresh:
    async def test_400_when_refresh_token_missing(self, client, mock_pool):
        async with client as c:
            res = await c.post("/api/auth/refresh", json={})
        assert res.status_code == 400

    async def test_401_on_garbage_refresh_token(self, client, mock_pool):
        async with client as c:
            res = await c.post("/api/auth/refresh", json={"refreshToken": "garbage"})
        assert res.status_code == 401

    async def test_401_when_refresh_token_is_actually_an_access_token(self, client, mock_pool):
        access_token = pyjwt.encode({"sub": 1, "role": "rep", "username": "arun"}, JWT_SECRET, algorithm="HS256")
        async with client as c:
            res = await c.post("/api/auth/refresh", json={"refreshToken": access_token})
        assert res.status_code == 401
        assert res.json()["error"] == "Invalid refresh token"

    async def test_200_with_new_access_token_for_valid_refresh_token(self, client, mock_pool):
        refresh_token = pyjwt.encode({"sub": 7, "type": "refresh"}, JWT_SECRET, algorithm="HS256")
        mock_pool.queue_fetchrow({"id": 7, "name": "Priya", "username": "priya", "role": "manager", "region": "North", "is_active": True})
        async with client as c:
            res = await c.post("/api/auth/refresh", json={"refreshToken": refresh_token})
        assert res.status_code == 200
        assert res.json()["accessToken"]


class TestForgotPassword:
    async def test_400_when_required_field_missing(self, client, mock_pool):
        async with client as c:
            res = await c.post("/api/auth/forgot-password", json={"username": "arun", "phone": "9876543210"})
        assert res.status_code == 400

    async def test_400_when_new_password_too_short(self, client, mock_pool):
        async with client as c:
            res = await c.post(
                "/api/auth/forgot-password",
                json={"username": "arun", "phone": "9876543210", "new_password": "abc"},
            )
        assert res.status_code == 400

    async def test_401_generic_message_when_username_not_found(self, client, mock_pool):
        mock_pool.queue_fetchrow(None)
        async with client as c:
            res = await c.post(
                "/api/auth/forgot-password",
                json={"username": "nobody", "phone": "9876543210", "new_password": "newpass1"},
            )
        assert res.status_code == 401
        assert res.json()["error"] == "Username not found"

    async def test_401_when_employee_deactivated(self, client, mock_pool):
        mock_pool.queue_fetchrow({"id": 1, "phone": "9876543210", "is_active": False})
        async with client as c:
            res = await c.post(
                "/api/auth/forgot-password",
                json={"username": "arun", "phone": "9876543210", "new_password": "newpass1"},
            )
        assert res.status_code == 401
        assert res.json()["error"] == "Username not found"

    async def test_401_when_phone_does_not_match(self, client, mock_pool):
        mock_pool.queue_fetchrow({"id": 1, "phone": "9876543210", "is_active": True})
        async with client as c:
            res = await c.post(
                "/api/auth/forgot-password",
                json={"username": "arun", "phone": "9999999999", "new_password": "newpass1"},
            )
        assert res.status_code == 401
        assert res.json()["error"] == "Phone number does not match our records"

    async def test_401_when_no_phone_on_file(self, client, mock_pool):
        mock_pool.queue_fetchrow({"id": 1, "phone": None, "is_active": True})
        async with client as c:
            res = await c.post(
                "/api/auth/forgot-password",
                json={"username": "arun", "phone": "9876543210", "new_password": "newpass1"},
            )
        assert res.status_code == 401
        assert res.json()["error"] == "Phone number does not match our records"

    async def test_matches_phone_with_different_formatting(self, client, mock_pool):
        mock_pool.queue_fetchrow({"id": 1, "phone": "98765 43210", "is_active": True})
        mock_pool.queue_execute("UPDATE 1")
        async with client as c:
            res = await c.post(
                "/api/auth/forgot-password",
                json={"username": "arun", "phone": "+91-9876543210", "new_password": "newpass1"},
            )
        assert res.status_code == 200

    async def test_200_hashes_and_persists_new_password(self, client, mock_pool):
        mock_pool.queue_fetchrow({"id": 42, "phone": "9876543210", "is_active": True})
        mock_pool.queue_execute("UPDATE 1")
        async with client as c:
            res = await c.post(
                "/api/auth/forgot-password",
                json={"username": "arun.kumar", "phone": "9876543210", "new_password": "newpass1"},
            )
        assert res.status_code == 200
        assert res.json()["success"] is True

        update_call = mock_pool.execute_calls[0]
        assert "UPDATE employees SET password_hash" in update_call.query
        new_hash, employee_id = update_call.args
        assert employee_id == 42
        assert bcrypt.checkpw(b"newpass1", new_hash.encode())
