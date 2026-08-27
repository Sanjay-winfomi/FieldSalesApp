"""
main.py — FastAPI entry point, ports src/index.js's boot sequence, middleware
order, route mounting, 404/error handling, and health checks exactly.
"""
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import JSONResponse

from app.core import config
from app.core.cors import DynamicCORSMiddleware
from app.core.logging_config import log_error, log_info
from app.core.rate_limit import API_LIMIT, API_LIMIT_MESSAGE, LOGIN_LIMIT_MESSAGE, limiter
from app.core.security_headers import SecurityHeadersMiddleware
from app.db import pool
from app.scheduler import start_scheduler, stop_scheduler

# ── Fail-fast boot checks — mirrors index.js's synchronous throws before
# app.listen(); here, before the FastAPI app object is even constructed. ──
config.run_boot_checks()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await pool.connect()
    start_scheduler()
    log_info(f"FieldTrack backend running", environment=config.NODE_ENV)
    yield
    stop_scheduler()
    await pool.disconnect()


app = FastAPI(lifespan=lifespan)

app.state.limiter = limiter


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    # loginLimiter is mounted only on /api/auth/login, /refresh, /forgot-password
    # (see app/routers/auth.py's @limiter.limit(LOGIN_LIMIT) overrides);
    # everything else under /api/ falls under the general apiLimiter applied
    # via Limiter(default_limits=[API_LIMIT]) in app/core/rate_limit.py. Both
    # share express-rate-limit's exact response body.
    if request.url.path.startswith("/api/auth/"):
        return JSONResponse(LOGIN_LIMIT_MESSAGE, status_code=429)
    return JSONResponse(API_LIMIT_MESSAGE, status_code=429)


app.add_middleware(SlowAPIMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(DynamicCORSMiddleware)


# ── Health checks — exempted from the default rate limit, mirroring the
# Node app never mounting apiLimiter outside the /api/ prefix. ──
@app.get("/health")
@limiter.exempt
async def health(request: Request):
    from datetime import datetime, timezone
    return {"status": "ok", "time": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}


@app.get("/health/deep")
@limiter.exempt
async def health_deep(request: Request):
    from datetime import datetime, timezone
    checks = {"database": "ok"}
    healthy = True
    try:
        await pool.fetch("SELECT 1")
    except Exception as err:  # noqa: BLE001
        healthy = False
        checks["database"] = "error"
        log_error("Deep health check: database unreachable", error=str(err))
    return JSONResponse(
        {"status": "ok" if healthy else "degraded", "time": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"), "checks": checks},
        status_code=200 if healthy else 503,
    )


# ── Routers ──
from app.routers import (  # noqa: E402
    assignments,
    attendance,
    auth,
    config as config_router,
    dashboard,
    dealers,
    employees,
    followup_requests,
    geocode,
    navigation,
    notes,
    notifications,
    reminders,
    reports,
    sync_failures,
    visits,
)

app.include_router(auth.router, prefix="/api/auth")
app.include_router(attendance.router, prefix="/api/attendance")
app.include_router(visits.router, prefix="/api/visits")
app.include_router(dealers.router, prefix="/api/dealers")
app.include_router(geocode.router, prefix="/api/geocode")
app.include_router(notes.router, prefix="/api/notes")
app.include_router(reminders.router, prefix="/api/reminders")
app.include_router(sync_failures.router, prefix="/api/sync-failures")
app.include_router(assignments.router, prefix="/api/assignments")
app.include_router(navigation.router, prefix="/api/navigation")
app.include_router(followup_requests.router, prefix="/api/followup-requests")
app.include_router(config_router.router, prefix="/api/config")
app.include_router(dashboard.router, prefix="/api/dashboard")
app.include_router(employees.router, prefix="/api/employees")
app.include_router(reports.router, prefix="/api/reports")
app.include_router(notifications.router, prefix="/api/notifications")


# ── 404 catch-all ──
@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    if exc.status_code == 404:
        return JSONResponse({"error": f"Route not found: {request.method} {request.url.path}"}, status_code=404)
    detail = exc.detail if isinstance(exc.detail, str) else "Internal server error"
    return JSONResponse({"error": detail}, status_code=exc.status_code)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse({"error": "Invalid request"}, status_code=400)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    log_error("Unhandled error", error=str(exc))
    return JSONResponse({"error": "Internal server error"}, status_code=500)
