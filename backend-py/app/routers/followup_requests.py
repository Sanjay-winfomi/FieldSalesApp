"""
followup_requests.py — ports followupRequests.routes.js exactly: a rep's ask
for a dealer to be (re-)assigned on a future date: an assigned dealer that
couldn't be visited today, or one that asked to be seen again on a specific
day. Lands in the manager notification feed with Approve/Reject actions;
approving creates the actual dealer_assignments row for the date the rep
asked for.

POST  /api/followup-requests             — rep-only: create a request
GET   /api/followup-requests             — manager-only: list (optional ?status=)
PATCH /api/followup-requests/{id}/approve — manager-only: approve + assign
PATCH /api/followup-requests/{id}/reject  — manager-only: reject
"""
import re
from datetime import datetime

from fastapi import APIRouter, Depends, Request
from starlette.responses import JSONResponse

from app.core.logging_config import log_error
from app.core.security import Employee, get_current_employee, require_manager, require_rep
from app.db import pool
from app.services import idempotency
from app.services.manager_notifications import create_manager_notification
from app.utils.business_day import get_business_date_string
from app.utils.json_shape import serialize_row, serialize_rows
from app.utils.pg_params import parse_date_string

router = APIRouter(dependencies=[Depends(get_current_employee)])

MIN_REASON_LENGTH = 10

REQUEST_FIELDS = (
    "r.id, r.employee_id, r.dealer_id, r.assignment_id, r.requested_date, r.reason, "
    "r.status, r.approved_date, r.resolved_by, r.resolved_at, r.created_at"
)
# Same field list but unaliased, for RETURNING clauses against a bare table
# (mirrors REQUEST_FIELDS.replace(/r\./g, '') in the Node source).
REQUEST_FIELDS_BARE = REQUEST_FIELDS.replace("r.", "")

_PARSE_INT_RE = re.compile(r"^\s*[-+]?\d+")


def _parse_int_loose(value):
    """Mirrors JS parseInt(value): leading numeric prefix, else NaN (-> None)."""
    if value is None:
        return None
    m = _PARSE_INT_RE.match(str(value))
    return int(m.group(0)) if m else None


def _validate_reason(reason):
    if not isinstance(reason, str):
        return None
    trimmed = reason.strip()
    return trimmed if len(trimmed) >= MIN_REASON_LENGTH else None


# Strict YYYY-MM-DD check — Date.parse() accepts many non-ISO formats
# (e.g. "08-13-2026") whose string-lexicographic order doesn't match
# calendar order, which broke the plain string `<` comparison against
# todayDateString() used for the past-date guards below.
_DATE_ONLY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _is_valid_date_string(value) -> bool:
    if not isinstance(value, str) or not _DATE_ONLY_RE.match(value):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%d")
        return True
    except ValueError:
        return False


# "Today" here means the current business day (5am IST rollover, see
# business_day.py) — the plain UTC calendar date would drift from it by up
# to DAY_BOUNDARY_HOUR minutes once a day, right after the boundary rolls
# over in IST but before the server's UTC calendar date does too.
def _today_date_string() -> str:
    return get_business_date_string()


# POST /api/followup-requests  { dealer_id, assignment_id?, requested_date, reason }
# rep-only: this is "a rep's ask" for a dealer to be (re-)assigned — a
# manager doesn't need this route since they can just save an assignment
# directly via PUT /api/assignments.
@router.post("")
async def create_followup_request(request: Request, employee: Employee = Depends(require_rep)):
    body = await request.json()

    dealer_id = _parse_int_loose(body.get("dealer_id"))
    if dealer_id is None:
        return JSONResponse({"error": "dealer_id is required"}, status_code=400)

    assignment_id = None
    raw_assignment_id = body.get("assignment_id")
    if raw_assignment_id is not None:
        assignment_id = _parse_int_loose(raw_assignment_id)
        if assignment_id is None:
            return JSONResponse({"error": "Invalid assignment_id"}, status_code=400)

    requested_date = body.get("requested_date")
    if not _is_valid_date_string(requested_date):
        return JSONResponse({"error": "Invalid requested_date"}, status_code=400)
    if requested_date < _today_date_string():
        return JSONResponse({"error": "requested_date_in_past"}, status_code=422)

    reason = _validate_reason(body.get("reason"))
    if not reason:
        return JSONResponse({"error": "reason_too_short", "minLength": MIN_REASON_LENGTH}, status_code=422)

    employee_id = employee.id
    idempotency_key = request.headers.get("idempotency-key")

    try:
        # The offline sync queue (mobile syncManager.js) retries this exact
        # request — same Idempotency-Key — whenever the network drops between
        # the server completing the insert and the client seeing the response.
        # Without this check, that retry created a second
        # dealer_followup_requests row and sent the manager a duplicate
        # notification for one ask.
        cached = await idempotency.get_idempotent_response(idempotency_key, employee_id, "followup-requests")
        if cached:
            return JSONResponse(cached["response_body"], status_code=cached["response_status"])

        dealer = await pool.fetchrow("SELECT id, name FROM dealers WHERE id = $1", dealer_id)
        if dealer is None:
            return JSONResponse({"error": "Dealer not found"}, status_code=404)

        if assignment_id is not None:
            # Must also match dealer_id (same guard as navigation.routes.js's
            # /compute) — without it, a rep could pass an assignment_id for a
            # completely different dealer than dealer_id in this same
            # request, storing a request whose linked assignment doesn't
            # match what it's actually about.
            assignment_row = await pool.fetchrow(
                "SELECT id FROM dealer_assignments WHERE id = $1 AND employee_id = $2 AND dealer_id = $3",
                assignment_id, employee_id, dealer_id,
            )
            if assignment_row is None:
                return JSONResponse({"error": "Assignment not found"}, status_code=404)

        request_row = await pool.fetchrow(
            f"""
            INSERT INTO dealer_followup_requests (employee_id, dealer_id, assignment_id, requested_date, reason)
            VALUES ($1, $2, $3, $4::date, $5) RETURNING {REQUEST_FIELDS_BARE}
            """,
            employee_id, dealer_id, assignment_id, parse_date_string(requested_date), reason,
        )
        request_dict = serialize_row(request_row)

        # Non-blocking-in-spirit but awaited (unlike visits.routes.js's
        # fire-and-forget markAssignmentVisited) — this notification IS the
        # point of the request; a rep submitting one should know it actually
        # reached the manager, not just that a local row got inserted.
        await create_manager_notification(
            type="followup_request",
            title="Follow-up visit requested",
            body=f'{employee.username} asked to (re-)visit {dealer["name"]} on {requested_date}. Reason: "{reason}"',
            severity="info",
            employee_id=employee_id,
            dealer_id=dealer_id,
            followup_request_id=request_row["id"],
        )

        response_body = {"request": request_dict}
        await idempotency.save_idempotent_response(idempotency_key, employee_id, "followup-requests", 201, response_body)
        return JSONResponse(response_body, status_code=201)
    except Exception as err:  # noqa: BLE001
        log_error("POST /api/followup-requests error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


# GET /api/followup-requests?status=pending
@router.get("")
async def list_followup_requests(request: Request, employee: Employee = Depends(require_manager)):
    status_val = request.query_params.get("status")
    if status_val and status_val not in ("pending", "approved", "rejected"):
        return JSONResponse({"error": "Invalid status"}, status_code=400)

    try:
        rows = await pool.fetch(
            f"""
            SELECT {REQUEST_FIELDS}, e.name AS employee_name, d.name AS dealer_name
            FROM dealer_followup_requests r
            JOIN employees e ON e.id = r.employee_id
            JOIN dealers d ON d.id = r.dealer_id
            {"WHERE r.status = $1" if status_val else ""}
            ORDER BY r.created_at DESC
            LIMIT 200
            """,
            *([status_val] if status_val else []),
        )
        return {"requests": serialize_rows(rows)}
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/followup-requests error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


# PATCH /api/followup-requests/{id}/approve — creates/keeps the
# dealer_assignments row for the rep's requested date, appended after
# whatever's already assigned that day (never reorders existing entries).
@router.patch("/{request_id}/approve")
async def approve_followup_request(request_id: str, request: Request, employee: Employee = Depends(require_manager)):
    id_val = _parse_int_loose(request_id)
    if id_val is None:
        return JSONResponse({"error": "Invalid request id"}, status_code=400)

    body = {}
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — no body / non-JSON body is fine, approved_date is optional
        body = {}

    # A dedicated client + transaction (rather than pool.query per statement)
    # — without this, two followup requests for the same employee/date
    # approved concurrently (two managers, or a double-click) could both read
    # the same MAX(sequence_order) before either INSERT commits, producing
    # two assignments with duplicate sequence_order and ambiguous visit
    # ordering. The advisory lock is the same one PUT /api/assignments already
    # takes for this employee/date, so the two routes properly serialize
    # against each other too, not just against themselves.
    conn = await pool.get_pool().acquire()
    try:
        existing = await conn.fetchrow("SELECT * FROM dealer_followup_requests WHERE id = $1", id_val)
        if existing is None:
            return JSONResponse({"error": "Request not found"}, status_code=404)
        if existing["status"] != "pending":
            return JSONResponse({"error": "request_already_resolved", "status": existing["status"]}, status_code=409)

        # A manager can approve for a different day than the rep asked for
        # (e.g. that date is already full) — defaults to what was requested.
        # asyncpg returns a plain datetime.date for the DATE column; normalize
        # to 'YYYY-MM-DD' so it compares/binds the same way as a caller-
        # supplied approved_date string below.
        approved_date = existing["requested_date"]
        if hasattr(approved_date, "isoformat"):
            approved_date = approved_date.isoformat()
        if body.get("approved_date") is not None:
            if not _is_valid_date_string(body["approved_date"]):
                return JSONResponse({"error": "Invalid approved_date"}, status_code=400)
            if body["approved_date"] < _today_date_string():
                return JSONResponse({"error": "approved_date_in_past"}, status_code=422)
            approved_date = body["approved_date"]

        # asyncpg binds a `::date`-cast/DATE-column parameter strictly from
        # a native datetime.date, not a string — see app/utils/pg_params.py.
        # Every string-comparison/validation use of approved_date above is
        # done; this is the last point before it's only ever used as a SQL
        # parameter.
        approved_date_val = parse_date_string(approved_date)

        tx = conn.transaction()
        await tx.start()
        try:
            # Transaction-scoped advisory lock keyed by employee_id + date —
            # see assignments.routes.js's PUT handler for the identical
            # pattern.
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtext(format('dealer_assignments:%s:%s', $1::int, $2::date)))",
                existing["employee_id"], approved_date_val,
            )

            # Claims the pending->approved transition atomically BEFORE
            # creating any assignment — `AND status = 'pending'` means only
            # one of a concurrent approve/reject race can ever win this
            # UPDATE. Without this, two requests racing (e.g. a manager
            # double-clicking, or two managers) could both pass the earlier
            # status check and each proceed with their own side effect,
            # leaving the request rejected while an assignment from the
            # "approve" path still got created. Ordering the claim before the
            # assignment INSERT means the loser returns 409 having created
            # nothing, rather than leaving a stray assignment behind either
            # way.
            updated = await conn.fetchrow(
                f"""
                UPDATE dealer_followup_requests
                SET status = 'approved', approved_date = $1, resolved_by = $2, resolved_at = NOW()
                WHERE id = $3 AND status = 'pending'
                RETURNING {REQUEST_FIELDS_BARE}
                """,
                approved_date_val, employee.id, id_val,
            )
            if updated is None:
                await tx.rollback()
                return JSONResponse({"error": "request_already_resolved"}, status_code=409)

            next_seq_row = await conn.fetchrow(
                """
                SELECT COALESCE(MAX(sequence_order), 0) + 1 AS next_seq
                FROM dealer_assignments WHERE employee_id = $1 AND assignment_date = $2::date
                """,
                existing["employee_id"], approved_date_val,
            )
            next_seq = next_seq_row["next_seq"]

            # ON CONFLICT DO UPDATE rather than DO NOTHING — guarantees
            # RETURNING always gives back a row, including when a manager
            # separately assigned this same dealer+date already. If that
            # existing row was 'cancelled' (e.g. the manager pre-cancelled it
            # before this request was approved), reactivate it to 'pending'
            # with a fresh sequence_order — otherwise the request reads as
            # "approved" while the rep's assignment list still shows it
            # cancelled. Any other existing status (pending/navigating/
            # arrived/completed) is left untouched, same as before.
            assignment_row = await conn.fetchrow(
                """
                INSERT INTO dealer_assignments (employee_id, dealer_id, assignment_date, sequence_order, assigned_by)
                VALUES ($1, $2, $3::date, $4, $5)
                ON CONFLICT (employee_id, dealer_id, assignment_date) DO UPDATE SET
                  status = CASE WHEN dealer_assignments.status = 'cancelled' THEN 'pending' ELSE dealer_assignments.status END,
                  sequence_order = CASE WHEN dealer_assignments.status = 'cancelled' THEN EXCLUDED.sequence_order ELSE dealer_assignments.sequence_order END,
                  updated_at = NOW()
                RETURNING id
                """,
                existing["employee_id"], existing["dealer_id"], approved_date_val, next_seq, employee.id,
            )
            assignment_id = assignment_row["id"]

            await tx.commit()
            return {"request": serialize_row(updated), "assignment_id": assignment_id}
        except Exception:
            # asyncpg's Transaction has no public is-completed check; a
            # second rollback() after a commit()/rollback() that already
            # happened would itself raise, so swallow that the same way the
            # Node source's own client.query('ROLLBACK').catch(() => {}) does.
            try:
                await tx.rollback()
            except Exception:  # noqa: BLE001
                pass
            raise
    except Exception as err:  # noqa: BLE001
        log_error("PATCH /api/followup-requests/:id/approve error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        await pool.get_pool().release(conn)


# PATCH /api/followup-requests/{id}/reject
@router.patch("/{request_id}/reject")
async def reject_followup_request(request_id: str, employee: Employee = Depends(require_manager)):
    id_val = _parse_int_loose(request_id)
    if id_val is None:
        return JSONResponse({"error": "Invalid request id"}, status_code=400)

    try:
        existing = await pool.fetchrow("SELECT status FROM dealer_followup_requests WHERE id = $1", id_val)
        if existing is None:
            return JSONResponse({"error": "Request not found"}, status_code=404)
        if existing["status"] != "pending":
            return JSONResponse({"error": "request_already_resolved", "status": existing["status"]}, status_code=409)

        # `AND status = 'pending'` makes this the atomic claim on the
        # transition (see the matching comment in /approve) — if an
        # approve/reject race already resolved it between the check above
        # and this UPDATE, rowCount is 0 here instead of silently
        # overwriting whatever the other request just committed.
        updated = await pool.fetchrow(
            f"""
            UPDATE dealer_followup_requests SET status = 'rejected', resolved_by = $1, resolved_at = NOW()
            WHERE id = $2 AND status = 'pending'
            RETURNING {REQUEST_FIELDS_BARE}
            """,
            employee.id, id_val,
        )
        if updated is None:
            return JSONResponse({"error": "request_already_resolved"}, status_code=409)
        return {"request": serialize_row(updated)}
    except Exception as err:  # noqa: BLE001
        log_error("PATCH /api/followup-requests/:id/reject error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)
