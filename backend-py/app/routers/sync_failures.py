"""sync_failures.py — ports syncFailures.routes.js exactly. A rep's device
reports here when a queued offline action permanently fails to sync (retried
past syncManager.js's MAX_RETRIES and discarded). Any authenticated employee
(rep or manager)."""
from fastapi import APIRouter, Depends, Request
from starlette.responses import JSONResponse

from app.core.logging_config import log_error
from app.core.security import Employee, get_current_employee
from app.db import pool
from app.services.manager_notifications import create_manager_notification

router = APIRouter(dependencies=[Depends(get_current_employee)])

# A device stuck on a bad connection can generate the same discarded action
# repeatedly (e.g. a recurring location-check ping failing the same way
# every 10 minutes) — without this, each one lands as its own manager
# notification and the feed turns into noise for what is really one ongoing
# problem. Suppress a duplicate for the same employee+endpoint within this
# window rather than inserting another row.
DEDUP_WINDOW_MINUTES = 60


@router.post("")
async def create_sync_failure(request: Request, employee: Employee = Depends(get_current_employee)):
    body = await request.json()
    method = body.get("method")
    url = body.get("url")
    error = body.get("error")
    employee_id = employee.id

    if not isinstance(url, str) or not url:
        return JSONResponse({"error": "url is required"}, status_code=400)

    try:
        # Escape LIKE metacharacters in the (client-controlled) url/method
        # before building the pattern — otherwise a url containing a literal
        # "%" or "_" (e.g. a query string) would act as a wildcard, matching
        # a broader (or narrower) set of prior bodies than the actual
        # method+url and dedupe either too aggressively or not at all.
        raw_target = f"{(method or 'post').upper()} {url}"
        escaped_target = raw_target.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        duplicate = await pool.fetchrow(
            f"""
            SELECT 1 FROM manager_notifications
            WHERE type = 'sync_failure' AND employee_id = $1 AND body LIKE $2 ESCAPE '\\'
              AND created_at > NOW() - INTERVAL '{DEDUP_WINDOW_MINUTES} minutes'
            LIMIT 1
            """,
            employee_id, f"%{escaped_target}%",
        )
        if duplicate is not None:
            return JSONResponse({"success": True, "deduped": True}, status_code=201)

        # Endpoint is generic (notes/reminders can queue offline too now, not
        # just attendance/visit), so the copy doesn't assume which kind of
        # record is affected.
        method_upper = (method or "post").upper()
        body_text = (
            f"{employee.username}'s device gave up retrying {method_upper} {url} — it never reached "
            f"the server. Whatever they were saving may be lost or out of date."
        )
        if error:
            body_text += f" ({error})"

        await create_manager_notification(
            type="sync_failure",
            title="Offline action failed to sync",
            body=body_text,
            severity="danger",
            employee_id=employee_id,
        )
        return JSONResponse({"success": True}, status_code=201)
    except Exception as err:  # noqa: BLE001
        log_error("POST /api/sync-failures error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)
