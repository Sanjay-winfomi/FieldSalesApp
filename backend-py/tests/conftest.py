"""conftest.py — pytest fixtures for the FastAPI parity test suite.

Set NODE_ENV=test before importing the app (matches the Node test suite's
own convention: logger.js goes silent, no file-transport logs directory is
created). Requires a real Postgres instance reachable via the DB_* env vars
— same as the Jest suite (backend/tests) uses a real DB, not a mock.
"""
import os

os.environ.setdefault("NODE_ENV", "test")
os.environ.setdefault("JWT_SECRET", "test_jwt_secret_not_for_production")

import pytest
import pytest_asyncio
from asgi_lifespan import LifespanManager
from httpx import ASGITransport, AsyncClient

from app.main import app
from tests.helpers.fake_pool import FakePool


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def client():
    # LifespanManager runs main.py's `lifespan()` startup/shutdown (DB pool
    # connect/disconnect, APScheduler start/stop) — ASGITransport alone does
    # not trigger ASGI lifespan events the way a real server does. Requires a
    # real reachable Postgres (DB_* env vars) — used by the smoke tests only.
    #
    # module-scoped (not the pytest-asyncio default of function-scoped): the
    # module-level `scheduler` singleton in app/scheduler.py (an APScheduler
    # AsyncIOScheduler) binds to whatever event loop is running when it's
    # started. A function-scoped client fixture starts/stops the full
    # lifespan — and therefore the scheduler — on a FRESH event loop for
    # every single test in the file; by the second test, the scheduler is
    # still holding a reference to the first test's already-closed loop,
    # and raises "RuntimeError: Event loop is closed". Scoping both the
    # fixture and its event loop to the module means the whole file's tests
    # share one lifespan/one loop, avoiding the cross-test loop mismatch
    # entirely. This is a test-harness-only concern — a real deployment
    # boots the app, and therefore the scheduler, exactly once.
    #
    # Every test FILE that uses this fixture must also mark its tests with
    # `pytestmark = pytest.mark.asyncio(loop_scope="module")` — pytest-asyncio
    # does not infer a test's own loop scope from the fixtures it requests,
    # so an unmarked test still gets its own per-test loop by default even
    # though `client` itself is module-scoped (this reproduced deterministically
    # as a 500/InterfaceError, not just "sometimes" — see the docstring in
    # test_health_and_auth.py for the full story). scheduler.py's
    # `start_scheduler()` also constructs a fresh AsyncIOScheduler() on every
    # call rather than reusing the module-level singleton, so that a SECOND
    # test file using this same fixture doesn't inherit the first file's
    # dead event-loop reference (AsyncIOScheduler.start() only ever captures
    # `asyncio.get_running_loop()` once, the first time it's started).
    async with LifespanManager(app) as manager:
        transport = ASGITransport(app=manager.app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            yield ac


@pytest.fixture
def mock_pool(monkeypatch):
    """A FakePool wired into app.db.pool's module-level fetch/fetchrow/
    execute/get_pool — for route unit tests that mock the DB entirely
    (mirrors backend/tests/routes/*.test.js's `jest.mock('../../src/db/pool',
    ...)`). Does NOT touch app.main's real lifespan/DB connection — use with
    tests/helpers/test_app.py's `make_client`/`make_app`, which build a
    fresh, minimal FastAPI app per test rather than importing app.main.app."""
    from tests.helpers.test_app import install_fake_pool

    fake = FakePool()
    install_fake_pool(monkeypatch, fake)
    return fake
