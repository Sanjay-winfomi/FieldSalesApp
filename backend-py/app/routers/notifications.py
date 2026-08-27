"""
notifications.py — ports notifications.routes.js exactly. Manager-facing
in-app notification bell feed.

GET    /              — list, newest first
GET    /unread-count  — lightweight poll target for the bell badge
PATCH  /:id/read      — mark one read
POST   /read-all      — mark all unread as read (on opening the page)
DELETE /:id           — permanently remove one, only once it's actually
                         reviewed/resolved (see _deletable_condition below)
DELETE /              — bulk version of the same rule — removes every
                         currently-eligible notification in one call

Read-state is shared across all managers, not per-manager-account — see
schema.sql's comment on manager_notifications for why.

Route registration order mirrors the Node file: GET /unread-count is defined
before PATCH/DELETE /:id so "unread-count" is never captured as an id (a
comment in the .js source calls this out explicitly).
"""
from fastapi import APIRouter, Depends
from starlette.responses import JSONResponse

from app.core.logging_config import log_error
from app.core.security import Employee, require_manager
from app.db import pool
from app.utils.json_shape import serialize_row, serialize_rows

router = APIRouter(dependencies=[Depends(require_manager)])

# A missed logout/login is serious enough that opening the notifications page
# shouldn't silently mark it read before a manager has actually looked at it
# and clicked "Reviewed" — every other notification type still gets the
# passive read-all-on-open behavior.
REQUIRES_EXPLICIT_REVIEW = ["day_auto_cutoff", "visit_auto_cutoff", "day_absent"]


# Shared by both the single and bulk DELETE routes below — a notification is
# only ever deletable once it's actually done: a REQUIRES_EXPLICIT_REVIEW
# type with its Reviewed click already recorded, or a follow-up request
# already approved/rejected (not still pending). Every other notification
# type — including a REQUIRES_EXPLICIT_REVIEW type that's still unread — has
# no "resolved" concept at all and is never matched, so nothing still needing
# a manager's attention can ever be cleared away, one at a time or in bulk.
# `array_param_index` is the 1-based position of the REQUIRES_EXPLICIT_REVIEW
# array parameter in that query's own params list (differs between the
# single-id route, which also binds the id, and the bulk route, which
# doesn't).
def _deletable_condition(array_param_index: int) -> str:
    return f"""(
        (n.type = ANY(${array_param_index}::varchar[]) AND n.read_at IS NOT NULL)
        OR (n.type = 'followup_request' AND EXISTS (
          SELECT 1 FROM dealer_followup_requests r
          WHERE r.id = n.followup_request_id AND r.status IN ('approved', 'rejected')
        ))
    )"""


# Clearing a notification removes it from the feed either way, but a
# 'day_absent' row is soft-dismissed (dismissed_at set) instead of actually
# deleted — absenceCheck.js's sweep re-flags the same (employee_id,
# business_date) pair every 15 minutes for as long as the rep still has no
# attendance row for it, and its dedup check is just "does a day_absent row
# for this pair still exist". A hard DELETE made the row's own existence stop
# guarding against that, so the exact same notification came back as a
# brand-new, unreviewed one on the next sweep. Leaving the row in place (just
# dismissed) keeps that guard intact while still disappearing from the feed
# (see the WHERE dismissed_at IS NULL in GET /). Every other type has no such
# regenerate-on-delete risk, so it's still a real DELETE.
def _clear_notifications_cte(target_where: str) -> str:
    return f"""
        WITH target AS (
          SELECT n.id, n.type FROM manager_notifications n WHERE {target_where}
        ),
        dismissed AS (
          UPDATE manager_notifications SET dismissed_at = NOW()
          WHERE id IN (SELECT id FROM target WHERE type = 'day_absent')
          RETURNING id
        ),
        removed AS (
          DELETE FROM manager_notifications
          WHERE id IN (SELECT id FROM target WHERE type <> 'day_absent')
          RETURNING id
        )
        SELECT id FROM dismissed
        UNION ALL
        SELECT id FROM removed
    """


@router.get("")
async def list_notifications(employee: Employee = Depends(require_manager)):
    try:
        rows = await pool.fetch(
            """
            SELECT n.id, n.type, n.title, n.body, n.severity, n.employee_id, e.name AS employee_name,
                   n.dealer_id, d.name AS dealer_name, n.visit_id, n.read_at, n.created_at,
                   n.followup_request_id, r.status AS followup_status,
                   r.requested_date AS followup_requested_date, r.approved_date AS followup_approved_date
            FROM manager_notifications n
            LEFT JOIN employees e ON e.id = n.employee_id
            LEFT JOIN dealers d    ON d.id = n.dealer_id
            LEFT JOIN dealer_followup_requests r ON r.id = n.followup_request_id
            WHERE n.dismissed_at IS NULL
            ORDER BY n.created_at DESC
            LIMIT 200
            """
        )
        return {"notifications": serialize_rows(rows)}
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/notifications error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.get("/unread-count")
async def unread_count(employee: Employee = Depends(require_manager)):
    try:
        row = await pool.fetchrow(
            "SELECT COUNT(*)::int AS count FROM manager_notifications WHERE read_at IS NULL AND dismissed_at IS NULL"
        )
        return {"count": row["count"]}
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/notifications/unread-count error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.post("/read-all")
async def read_all(employee: Employee = Depends(require_manager)):
    try:
        await pool.execute(
            "UPDATE manager_notifications SET read_at = NOW() WHERE read_at IS NULL AND type != ALL($1::varchar[])",
            REQUIRES_EXPLICIT_REVIEW,
        )
        return {"success": True}
    except Exception as err:  # noqa: BLE001
        log_error("POST /api/notifications/read-all error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.patch("/{notification_id}/read")
async def mark_read(notification_id: str, employee: Employee = Depends(require_manager)):
    try:
        id_val = int(notification_id)
    except ValueError:
        return JSONResponse({"error": "Invalid notification id"}, status_code=400)

    try:
        row = await pool.fetchrow(
            "UPDATE manager_notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = $1 RETURNING id, read_at",
            id_val,
        )
        if row is None:
            return JSONResponse({"error": "Notification not found"}, status_code=404)
        return {"notification": serialize_row(row)}
    except Exception as err:  # noqa: BLE001
        log_error("PATCH /api/notifications/:id/read error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


# DELETE /:id — permanently clears one notification, if (and only if)
# _deletable_condition matches it. Enforced here, not just hidden
# client-side, so this can't be bypassed by calling the endpoint directly.
@router.delete("/{notification_id}")
async def delete_notification(notification_id: str, employee: Employee = Depends(require_manager)):
    try:
        id_val = int(notification_id)
    except ValueError:
        return JSONResponse({"error": "Invalid notification id"}, status_code=400)

    try:
        rows = await pool.fetch(
            _clear_notifications_cte(f"n.id = $1 AND {_deletable_condition(2)}"),
            id_val, REQUIRES_EXPLICIT_REVIEW,
        )
        if len(rows) == 0:
            return JSONResponse({"error": "Notification not found, or not yet reviewed/resolved"}, status_code=404)
        return {"success": True}
    except Exception as err:  # noqa: BLE001
        log_error("DELETE /api/notifications/:id error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


# DELETE / — bulk-clears every currently-eligible notification in one call
# (the "Clear all resolved" button) — same _deletable_condition, just with no
# `id` filter. Reports how many were actually removed so the UI can show a
# real count rather than assuming every row shown as deletable client-side
# still was by the time this ran.
@router.delete("")
async def delete_all_notifications(employee: Employee = Depends(require_manager)):
    try:
        rows = await pool.fetch(
            _clear_notifications_cte(_deletable_condition(1)),
            REQUIRES_EXPLICIT_REVIEW,
        )
        return {"success": True, "deleted": len(rows)}
    except Exception as err:  # noqa: BLE001
        log_error("DELETE /api/notifications error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)
