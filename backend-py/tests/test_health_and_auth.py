"""Smoke tests against the REAL app (real DB, real lifespan/scheduler) —
health checks and basic auth gating. Ported informally from
backend/tests/routes/auth.routes.test.js and
backend/tests/middleware/auth.middleware.test.js; the full 1:1 Jest port
lives in tests/routes/test_auth_routes.py and tests/test_auth_middleware.py
(DB-mocked, no live server needed) — this file exists only to sanity-check
the real app boots and answers correctly end-to-end.

Root cause of the flakiness this file used to work around by cramming every
assertion into one test function: the `client` fixture is module-scoped
(`loop_scope="module"`, see conftest.py) so the DB pool/scheduler bind to one
event loop for the whole module — but pytest-asyncio does NOT infer a test's
own loop scope from the fixtures it requests. Left unmarked, each `async def
test_x` still gets its own per-test event loop by default, so the second
test in the file ran its query through a pool bound to a *different* loop
than the one it was created on — reproduced deterministically as either an
`asyncpg.InterfaceError: cannot perform operation: another operation is in
progress` or a bare 500 on the second test, depending on timing. Explicitly
marking every test `@pytest.mark.asyncio(loop_scope="module")` pins it to
the same loop as the `client` fixture, which resolves it outright — verified
with 5 consecutive clean runs before removing the old single-function
workaround.
"""
import pytest

pytestmark = pytest.mark.asyncio(loop_scope="module")


async def test_health_check(client):
    response = await client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert "time" in body


async def test_login_requires_username_and_password(client):
    response = await client.post("/api/auth/login", json={})
    assert response.status_code == 400
    assert response.json() == {"error": "username and password are required"}


async def test_login_rejects_unknown_username(client):
    response = await client.post("/api/auth/login", json={"username": "not_a_real_user", "password": "whatever"})
    assert response.status_code == 401
    assert response.json() == {"error": "Username not found"}


async def test_protected_route_rejects_missing_auth_header(client):
    response = await client.get("/api/attendance/today")
    assert response.status_code == 401
    assert response.json() == {"error": "Missing or malformed Authorization header"}


async def test_protected_route_rejects_invalid_jwt(client):
    response = await client.get("/api/attendance/today", headers={"Authorization": "Bearer not-a-real-jwt"})
    assert response.status_code == 401
    assert response.json() == {"error": "Invalid token"}


async def test_unknown_route_returns_404(client):
    response = await client.get("/api/this-route-does-not-exist")
    assert response.status_code == 404
    assert response.json() == {"error": "Route not found: GET /api/this-route-does-not-exist"}
