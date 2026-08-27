"""
pool.py — asyncpg connection pool, raw SQL only (no ORM), mirroring
src/db/pool.js exactly (same env vars, same defaults, same SSL handling).

Note (NOTES.md): pool.js installs a custom type parser for SQL DATE columns
(OID 1082) to work around `pg` returning a JS Date at local midnight, which
then serializes to UTC and drifts across a day boundary in IST. asyncpg has
no equivalent bug — it returns Python `datetime.date` objects, which FastAPI/
Pydantic serialize as plain 'YYYY-MM-DD' strings with no timezone attached —
so no workaround is needed here. Call `.isoformat()` explicitly wherever a
route hand-builds a dict instead of returning a Pydantic model, to keep
response shapes identical to the Node backend's plain date strings.
"""
import ssl as ssl_lib

import asyncpg

from app.core import config
from app.core.logging_config import log_error

_pool: asyncpg.Pool | None = None


def _build_ssl_arg():
    """Mirrors pool.js's `ssl: useSsl ? { rejectUnauthorized: ... } : false`.

    BUG FIXED HERE (found live against Render's managed Postgres — never
    exercised by local testing, which always ran DB_SSL=false): asyncpg's
    `ssl` parameter takes `True` / `False` / an `ssl.SSLContext`, NOT the
    string `"require"`. The original version of this function passed
    `ssl="require"` (invalid) when DB_SSL_REJECT_UNAUTHORIZED was true, and
    — worse — passed `ssl=True` (full certificate verification) when
    DB_SSL_REJECT_UNAUTHORIZED was FALSE, which is backwards: `True` makes
    asyncpg verify the server's certificate against the system trust store,
    which fails immediately for Render's managed Postgres cert (it doesn't
    chain to a standard root CA — the exact reason Node's own
    `rejectUnauthorized: false` exists). That failed handshake surfaces as
    `asyncpg.exceptions.ConnectionDoesNotExistError: connection was closed
    in the middle of operation` — not an obviously SSL-shaped error message,
    which is why this took a real deploy to surface.
    """
    if not config.DB_SSL:
        return None
    if config.DB_SSL_REJECT_UNAUTHORIZED:
        return True
    ctx = ssl_lib.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl_lib.CERT_NONE
    return ctx


async def connect() -> None:
    global _pool
    _pool = await asyncpg.create_pool(
        host=config.DB_HOST,
        port=config.DB_PORT,
        database=config.DB_NAME,
        user=config.DB_USER,
        password=config.DB_PASSWORD,
        ssl=_build_ssl_arg(),
        min_size=1,
        max_size=config.DB_POOL_MAX,
        max_inactive_connection_lifetime=config.DB_IDLE_TIMEOUT_MS / 1000,
        timeout=config.DB_CONNECTION_TIMEOUT_MS / 1000,
    )


async def disconnect() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def get_pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("DB pool accessed before connect() — app not started correctly.")
    return _pool


async def fetch(query: str, *args):
    try:
        return await get_pool().fetch(query, *args)
    except Exception as err:  # noqa: BLE001 — mirrors pool.on('error') best-effort logging
        log_error("Unexpected PostgreSQL client error", error=str(err))
        raise


async def fetchrow(query: str, *args):
    return await get_pool().fetchrow(query, *args)


async def execute(query: str, *args) -> str:
    return await get_pool().execute(query, *args)
