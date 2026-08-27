"""
security_headers.py — reproduces helmet@8.3.0's default header set exactly
(index.js applies `helmet()` with no custom options). crossOriginEmbedderPolicy
is NOT part of helmet's defaults (opt-in only) and is deliberately omitted here.
"""
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

_DEFAULT_CSP = (
    "default-src 'self';"
    "base-uri 'self';"
    "font-src 'self' https: data:;"
    "form-action 'self';"
    "frame-ancestors 'self';"
    "img-src 'self' data:;"
    "object-src 'none';"
    "script-src 'self';"
    "script-src-attr 'none';"
    "style-src 'self' https: 'unsafe-inline';"
    "upgrade-insecure-requests"
)

_HEADERS = {
    "Content-Security-Policy": _DEFAULT_CSP,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Origin-Agent-Cluster": "?1",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-DNS-Prefetch-Control": "off",
    "X-Download-Options": "noopen",
    "X-Frame-Options": "SAMEORIGIN",
    "X-Permitted-Cross-Domain-Policies": "none",
    "X-XSS-Protection": "0",
}


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        for name, value in _HEADERS.items():
            response.headers[name] = value
        return response
