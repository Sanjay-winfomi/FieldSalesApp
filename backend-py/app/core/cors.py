"""
cors.py — dynamic CORS, porting index.js's `cors()` origin callback exactly.

Fallback logic (do NOT simplify):
  - No Origin header at all → always allowed (server-to-server/curl/native
    mobile fetches that don't send Origin).
  - ALLOWED_ORIGINS set (comma-separated, exact string match, no
    trimming/case-normalization) → only listed origins allowed; anything
    else is rejected. Enforced already at boot: refuses to start in
    production without it (see config.run_boot_checks).
  - ALLOWED_ORIGINS unset (dev only) → falls back to any localhost/private-LAN
    (RFC1918) hostname, any port, any URL scheme (explicitly includes
    Expo Go's `exp://`) — parsed via hostname only, not a scheme-specific
    regex. An unparsable Origin value is rejected (fail-closed).
A rejected origin gets a 403 {"error": "Origin not allowed"} — mirroring the
Node app's isCorsError tagging + global error handler — not just an omitted
CORS header, matching the Node app blocking the request server-side too.
"""
from urllib.parse import urlparse

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from app.core import config
from app.core.logging_config import log_warn


def _is_local_origin(origin: str) -> bool:
    try:
        hostname = urlparse(origin).hostname
    except ValueError:
        return False
    if not hostname:
        return False
    return bool(config.PRIVATE_HOSTNAME_PATTERN.match(hostname))


def _is_origin_allowed(origin: str) -> bool:
    if config.EXPLICIT_ALLOWED_ORIGINS is not None:
        return origin in config.EXPLICIT_ALLOWED_ORIGINS
    return _is_local_origin(origin)


class DynamicCORSMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        origin = request.headers.get("origin")

        if origin:
            if not _is_origin_allowed(origin):
                if config.EXPLICIT_ALLOWED_ORIGINS is not None:
                    log_warn(f'CORS rejected origin (not in ALLOWED_ORIGINS): "{origin}"')
                else:
                    log_warn(f'CORS rejected origin (not a local/private-LAN origin): "{origin}"')
                return JSONResponse({"error": "Origin not allowed"}, status_code=403)

        if request.method == "OPTIONS" and origin:
            response = JSONResponse({}, status_code=204)
        else:
            response = await call_next(request)

        if origin:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Credentials"] = "true"
            response.headers["Vary"] = "Origin"
            if request.method == "OPTIONS":
                response.headers["Access-Control-Allow-Methods"] = "GET,HEAD,PUT,PATCH,POST,DELETE"
                requested_headers = request.headers.get("access-control-request-headers")
                if requested_headers:
                    response.headers["Access-Control-Allow-Headers"] = requested_headers
        return response
