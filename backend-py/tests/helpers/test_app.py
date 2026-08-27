"""
test_app.py — mounts a single router on a minimal FastAPI app for route unit
tests, playing the same role backend/tests/helpers/testApp.js's `makeApp`
plays for the Node suite: a fake `req.employee` (here, a FastAPI dependency
override) so route tests focus on the route's own logic against a mocked
pool, not real JWT verification.
"""
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.core.security import Employee, get_current_employee, require_manager, require_rep
from app.db import pool as pool_module


def make_app(router, prefix: str = "/api/x", employee: Employee | None = None) -> FastAPI:
    if employee is None:
        employee = Employee(id=1, role="rep", username="testuser")

    app = FastAPI()
    app.include_router(router, prefix=prefix)

    async def _fake_employee():
        return employee

    app.dependency_overrides[get_current_employee] = _fake_employee
    # require_manager/require_rep are themselves dependency-injected callables
    # built from get_current_employee via Depends(...) — overriding the base
    # dependency is enough for FastAPI to substitute it everywhere it's
    # depended on transitively, including inside require_manager/require_rep,
    # so no separate override is needed for those two.
    return app


def make_client(router, prefix: str = "/api/x", employee: Employee | None = None) -> AsyncClient:
    app = make_app(router, prefix, employee)
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


def install_fake_pool(monkeypatch, fake_pool):
    """Patches app.db.pool's module-level fetch/fetchrow/execute/get_pool to
    route through `fake_pool` — mirrors jest.mock('../../src/db/pool', ...)."""
    monkeypatch.setattr(pool_module, "fetch", fake_pool.fetch)
    monkeypatch.setattr(pool_module, "fetchrow", fake_pool.fetchrow)
    monkeypatch.setattr(pool_module, "execute", fake_pool.execute)
    monkeypatch.setattr(pool_module, "get_pool", fake_pool.get_pool)
