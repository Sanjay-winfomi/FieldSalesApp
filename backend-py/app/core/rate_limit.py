"""
rate_limit.py — ports express-rate-limit's two limiters exactly:
  - apiLimiter:   200 requests / 15 min, mounted on every /api/ path
  - loginLimiter: 20 requests / 15 min, mounted on /api/auth/login,
                   /api/auth/refresh, /api/auth/forgot-password only
Both key on client IP, which — same as the Node app — only honors
X-Forwarded-For when NODE_ENV=production (TRUST_PROXY_HOPS hops trusted);
in dev every request appears to share one IP unless behind a real proxy.
"""
from slowapi import Limiter
from slowapi.util import get_remote_address
from starlette.requests import Request

from app.core import config


def get_client_ip(request: Request) -> str:
    if not config.IS_PRODUCTION:
        return get_remote_address(request)

    remote = request.client.host if request.client else "unknown"
    xff = request.headers.get("x-forwarded-for")
    if not xff:
        return remote

    # Mirrors Express's `trust proxy` numeric-hop algorithm: walk back
    # TRUST_PROXY_HOPS entries from the socket address through the reversed
    # X-Forwarded-For chain (nearest-proxy-first once reversed).
    chain = [remote] + [ip.strip() for ip in reversed(xff.split(","))]
    index = min(config.TRUST_PROXY_HOPS, len(chain) - 1)
    return chain[index]


API_LIMIT = "200/15minutes"
LOGIN_LIMIT = "20/15minutes"

# default_limits applies API_LIMIT to every route automatically (mirrors
# `app.use('/api/', apiLimiter)` mounted once for the whole API) — routes
# under /api/auth override it with the stricter LOGIN_LIMIT via their own
# @limiter.limit(LOGIN_LIMIT) decorator (slowapi: the most specific decorator
# on a route wins over default_limits). /health and /health/deep are marked
# @limiter.exempt in main.py since the Node app never mounted apiLimiter on
# them (only on the /api/ prefix).
limiter = Limiter(key_func=get_client_ip, default_limits=[API_LIMIT], headers_enabled=True)

API_LIMIT_MESSAGE = {"error": "Too many requests, please try again later."}
LOGIN_LIMIT_MESSAGE = {"error": "Too many login attempts, please try again in 15 minutes."}
