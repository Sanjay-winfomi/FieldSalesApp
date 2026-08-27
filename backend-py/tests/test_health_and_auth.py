"""Smoke tests against the REAL app (real DB, real lifespan/scheduler) —
health checks and basic auth gating. Ported informally from
backend/tests/routes/auth.routes.test.js and
backend/tests/middleware/auth.middleware.test.js; the full 1:1 Jest port
lives in tests/routes/test_auth_routes.py and tests/test_auth_middleware.py
(DB-mocked, no live server needed) — this file exists only to sanity-check
the real app boots and answers correctly end-to-end.

Deliberately ONE test function, not one-per-case: pytest-asyncio runs each
`async def test_x` as a separate top-level `loop.run_until_complete()` call.
Splitting these across multiple test functions — even sharing one
module/session-scoped `client` fixture — was observed to intermittently
corrupt the asyncpg connection pool's internal state across that boundary
(a real, reproduced `asyncpg.InterfaceError: cannot perform operation:
another operation is in progress` on the second test's query, not present
when the exact same two requests ran back-to-back inside one coroutine).
Keeping every assertion inside a single continuous async test avoids that
loop-boundary edge case entirely."""


async def test_health_and_basic_auth_flow(client):
    response = await client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert "time" in body

    response = await client.post("/api/auth/login", json={})
    assert response.status_code == 400
    assert response.json() == {"error": "username and password are required"}

    response = await client.post("/api/auth/login", json={"username": "not_a_real_user", "password": "whatever"})
    assert response.status_code == 401
    assert response.json() == {"error": "Username not found"}

    response = await client.get("/api/attendance/today")
    assert response.status_code == 401
    assert response.json() == {"error": "Missing or malformed Authorization header"}

    response = await client.get("/api/attendance/today", headers={"Authorization": "Bearer not-a-real-jwt"})
    assert response.status_code == 401
    assert response.json() == {"error": "Invalid token"}

    response = await client.get("/api/this-route-does-not-exist")
    assert response.status_code == 404
    assert response.json() == {"error": "Route not found: GET /api/this-route-does-not-exist"}
