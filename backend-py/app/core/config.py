"""
config.py — environment configuration, read once at import time.

Mirrors src/index.js / src/db/pool.js / src/utils/logger.js / businessDay.js's
own env-var reading exactly, including their specific fallback behavior.
"""
import os
import re
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

PLACEHOLDER_JWT_SECRET = "fieldtrack_jwt_secret_change_in_production_2026"

NODE_ENV = os.environ.get("NODE_ENV", "development")
IS_PRODUCTION = NODE_ENV == "production"
IS_TEST = NODE_ENV == "test"

PORT = int(os.environ.get("PORT", "3001"))

# --- DB ---------------------------------------------------------------
DB_HOST = os.environ.get("DB_HOST", "localhost")
DB_PORT = int(os.environ.get("DB_PORT", "5432"))
DB_NAME = os.environ.get("DB_NAME", "fieldtrack")
DB_USER = os.environ.get("DB_USER", "postgres")
DB_PASSWORD = os.environ.get("DB_PASSWORD", "")
DB_SSL = os.environ.get("DB_SSL") == "true"
DB_SSL_REJECT_UNAUTHORIZED = os.environ.get("DB_SSL_REJECT_UNAUTHORIZED") != "false"
DB_POOL_MAX = int(os.environ.get("DB_POOL_MAX", "10"))
DB_IDLE_TIMEOUT_MS = int(os.environ.get("DB_IDLE_TIMEOUT_MS", "30000"))
DB_CONNECTION_TIMEOUT_MS = int(os.environ.get("DB_CONNECTION_TIMEOUT_MS", "5000"))

# --- Auth ---------------------------------------------------------------
JWT_SECRET = os.environ.get("JWT_SECRET")
JWT_EXPIRES_IN = os.environ.get("JWT_EXPIRES_IN", "8h")
JWT_REFRESH_EXPIRES_IN = os.environ.get("JWT_REFRESH_EXPIRES_IN", "7d")

# --- Networking / security ----------------------------------------------
TRUST_PROXY_HOPS = int(os.environ.get("TRUST_PROXY_HOPS", "1"))
ALLOWED_ORIGINS = os.environ.get("ALLOWED_ORIGINS")
EXPLICIT_ALLOWED_ORIGINS = ALLOWED_ORIGINS.split(",") if ALLOWED_ORIGINS else None

PRIVATE_HOSTNAME_PATTERN = re.compile(
    r"^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)$"
)

# --- Field-sales business constants --------------------------------------
LOGIN_RADIUS_METERS = int(os.environ.get("LOGIN_RADIUS_METERS", "200"))


def _finite_int(raw, default):
    try:
        value = int(raw)
        return value
    except (TypeError, ValueError):
        return default


GPS_ACCURACY_THRESHOLD_METERS = _finite_int(os.environ.get("GPS_ACCURACY_THRESHOLD_METERS"), 30)
LOGIN_MATCH_TOLERANCE_METERS = _finite_int(os.environ.get("LOGIN_MATCH_TOLERANCE_METERS"), 20)

_raw_day_boundary = os.environ.get("DAY_BOUNDARY_HOUR")
try:
    _day_boundary_candidate = int(_raw_day_boundary)
    DAY_BOUNDARY_HOUR = _day_boundary_candidate if 0 <= _day_boundary_candidate <= 23 else 5
except (TypeError, ValueError):
    DAY_BOUNDARY_HOUR = 5

# --- Third-party ---------------------------------------------------------
GOOGLE_MAPS_API_KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "")

# --- Logging ---------------------------------------------------------
LOG_DIR = os.environ.get("LOG_DIR") or str(Path(__file__).resolve().parents[2] / "logs")
LOG_LEVEL = os.environ.get("LOG_LEVEL") or ("info" if IS_PRODUCTION else "debug")


def run_boot_checks() -> None:
    """Fail-fast checks — must run before the app starts serving, mirrors
    index.js's synchronous throws executed before app.listen()."""
    if not JWT_SECRET:
        raise RuntimeError("JWT_SECRET must be set — refusing to start without it.")
    if IS_PRODUCTION and JWT_SECRET == PLACEHOLDER_JWT_SECRET:
        raise RuntimeError(
            "JWT_SECRET is still the .env.example placeholder — set a real secret before running in production."
        )
    if IS_PRODUCTION and not ALLOWED_ORIGINS:
        raise RuntimeError(
            "ALLOWED_ORIGINS must be set in production (comma-separated list of allowed origins) — "
            "refusing to start with the permissive local-dev CORS fallback."
        )
