"""
idempotency.py — ports idempotency.js exactly. Dedupes retried mutating
requests (mobile client's cold-start retry) via the Idempotency-Key header.
Scoped by (key, employee_id, endpoint) — see idempotency.js's docstring for
why both employee_id and endpoint scoping matter, not just the key.
"""
import json

from app.core.logging_config import log_error
from app.db import pool

RETENTION_HOURS = 24


async def get_idempotent_response(key: str | None, employee_id: int, endpoint: str) -> dict | None:
    if not key:
        return None
    row = await pool.fetchrow(
        "SELECT response_status, response_body FROM idempotency_keys "
        "WHERE key = $1 AND employee_id = $2 AND endpoint = $3",
        key, employee_id, endpoint,
    )
    if row is None:
        return None
    return {"response_status": row["response_status"], "response_body": json.loads(row["response_body"])}


async def save_idempotent_response(key: str | None, employee_id: int, endpoint: str, status: int, body: dict) -> None:
    if not key:
        return
    await pool.execute(
        "INSERT INTO idempotency_keys (key, employee_id, endpoint, response_status, response_body) "
        "VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (key) DO NOTHING",
        key, employee_id, endpoint, status, json.dumps(body),
    )


async def cleanup_old_idempotency_keys() -> None:
    try:
        await pool.execute(
            f"DELETE FROM idempotency_keys WHERE created_at < NOW() - INTERVAL '{RETENTION_HOURS} hours'"
        )
    except Exception as err:  # noqa: BLE001
        log_error("Failed to clean up old idempotency keys", error=str(err))
