"""Ported from backend/tests/middleware/auth.middleware.test.js — same test
intent, same status codes / error messages, adapted from Jest's fake
req/res/next objects to a minimal FastAPI app exercising the REAL
`get_current_employee` / `require_role` dependencies over HTTP (via
httpx.AsyncClient + ASGITransport), since this file tests the dependency's
own request-handling logic rather than a mounted router — unlike
tests/helpers/test_app.py's `make_client`, which overrides
`get_current_employee` for other route tests, here we deliberately do NOT
override it.

Node's `requireAuth` mocks `pool.query` per test via
`pool.query.mockResolvedValueOnce(...)`; the Python port's DB access goes
through `pool.fetchrow`, mocked here the same way the rest of the suite
does it — via the `mock_pool` fixture (tests/conftest.py) queuing results
with `mock_pool.queue_fetchrow(...)`.
"""
import pytest
from fastapi import Depends, FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from httpx import ASGITransport, AsyncClient
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core import security
from app.core.security import Employee, get_current_employee, require_manager, sign_access_token


def build_app() -> FastAPI:
    """A minimal app exposing the real get_current_employee/require_manager
    dependencies, with the same {"error": ...} HTTPException shape app.main
    installs (see app/main.py's http_exception_handler) so response bodies
    match the rest of the ported suite."""
    app = FastAPI()

    @app.get("/whoami")
    async def whoami(employee: Employee = Depends(get_current_employee)):
        return {"id": employee.id, "role": employee.role, "username": employee.username}

    @app.get("/manager-only")
    async def manager_only(employee: Employee = Depends(require_manager)):
        return {"ok": True}

    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request, exc: StarletteHTTPException):
        detail = exc.detail if isinstance(exc.detail, str) else "Internal server error"
        return JSONResponse({"error": detail}, status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(request, exc: RequestValidationError):
        return JSONResponse({"error": "Invalid request"}, status_code=400)

    return app


@pytest.fixture
def client():
    app = build_app()
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


@pytest.fixture(autouse=True)
def _clear_employee_state_cache():
    # security._employee_state_cache is module-level global state (mirrors
    # Node's module-level `employeeStateCache` Map) — clear it before AND
    # after each test so cache hits from one test never leak into another.
    security._employee_state_cache.clear()
    yield
    security._employee_state_cache.clear()


class TestGetCurrentEmployee:
    """Ports the Jest `describe('requireAuth', ...)` block."""

    async def test_rejects_a_request_with_no_authorization_header(self, client, mock_pool):
        async with client as c:
            res = await c.get("/whoami")
        assert res.status_code == 401

    async def test_rejects_an_invalid_token(self, client, mock_pool):
        async with client as c:
            res = await c.get("/whoami", headers={"authorization": "Bearer not-a-real-token"})
        assert res.status_code == 401
        assert res.json() == {"error": "Invalid token"}

    async def test_rejects_a_valid_token_for_a_deactivated_employee(self, client, mock_pool):
        mock_pool.queue_fetchrow({"is_active": False, "role": None})
        token = sign_access_token(1, "rep", "arun")
        async with client as c:
            res = await c.get("/whoami", headers={"authorization": f"Bearer {token}"})
        assert res.status_code == 401
        assert res.json() == {"error": "Account is deactivated"}

    async def test_attaches_employee_and_succeeds_for_a_valid_active_employee(self, client, mock_pool):
        mock_pool.queue_fetchrow({"is_active": True, "role": None})
        token = sign_access_token(42, "manager", "priya")
        async with client as c:
            res = await c.get("/whoami", headers={"authorization": f"Bearer {token}"})
        assert res.status_code == 200
        assert res.json() == {"id": 42, "role": "manager", "username": "priya"}


class TestRequireRole:
    """Ports the Jest `describe('requireRole', ...)` block, using
    require_manager (= require_role('manager')) as the concrete case."""

    async def test_403s_when_the_employee_role_does_not_match(self, client, mock_pool):
        mock_pool.queue_fetchrow({"is_active": True, "role": None})
        token = sign_access_token(1, "rep", "arun")
        async with client as c:
            res = await c.get("/manager-only", headers={"authorization": f"Bearer {token}"})
        assert res.status_code == 403
        assert res.json() == {"error": "Requires role: manager"}

    async def test_calls_next_when_the_employee_role_matches(self, client, mock_pool):
        mock_pool.queue_fetchrow({"is_active": True, "role": None})
        token = sign_access_token(1, "manager", "priya")
        async with client as c:
            res = await c.get("/manager-only", headers={"authorization": f"Bearer {token}"})
        assert res.status_code == 200
        assert res.json() == {"ok": True}

    async def test_401s_when_there_is_no_authenticated_employee(self, client, mock_pool):
        # Genuine Node-vs-Python divergence, not a setup mistake: Node's
        # requireRole is a standalone middleware that separately checks
        # `req.employee` and replies {"error": "Not authenticated"} when
        # requireAuth never ran. The Python port's require_role (security.py)
        # has no such branch — it is built as
        # `Depends(get_current_employee)`, so "no authenticated employee"
        # can only happen via get_current_employee's own guard, which
        # replies {"error": "Missing or malformed Authorization header"}
        # instead. Both still correctly reject with 401; only the message
        # text differs, as an inherent consequence of the Python port's
        # dependency-injection architecture (see security.py's docstring).
        async with client as c:
            res = await c.get("/manager-only")
        assert res.status_code == 401
        assert res.json() == {"error": "Missing or malformed Authorization header"}
