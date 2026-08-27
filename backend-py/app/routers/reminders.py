"""reminders.py — ports reminders.routes.js exactly (dealer follow-up
reminders). Any authenticated employee; owner-only enforcement on
PATCH/DELETE."""
import re

from fastapi import APIRouter, Depends, Request
from starlette.responses import JSONResponse

from app.core.logging_config import log_error
from app.core.security import Employee, get_current_employee
from app.db import pool
from app.utils.business_day import get_business_date_string
from app.utils.json_shape import serialize_row, serialize_rows
from app.utils.pg_params import parse_date_string

router = APIRouter(dependencies=[Depends(get_current_employee)])

MIN_NOTE_LENGTH = 20
REMINDER_FIELDS = (
    "id, employee_id, dealer_id, reminder_date, note, "
    "notif_id_day_before, notif_id_day_of, created_at"
)

# Strict YYYY-MM-DD check — a lenient parse accepts many non-ISO formats
# whose string-lexicographic order doesn't match calendar order, which would
# break the plain string `<` comparison against today's business date below.
_DATE_ONLY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _validate_note(note) -> str | None:
    if not isinstance(note, str):
        return None
    trimmed = note.strip()
    return trimmed if len(trimmed) >= MIN_NOTE_LENGTH else None


def _is_valid_date_string(value) -> bool:
    if not isinstance(value, str) or not _DATE_ONLY_RE.match(value):
        return False
    year, month, day = (int(p) for p in value.split("-"))
    if not (1 <= month <= 12):
        return False
    import calendar

    max_day = calendar.monthrange(year, month)[1]
    return 1 <= day <= max_day


def _today_date_string() -> str:
    # "Today" here means the current business day (5am IST rollover, see
    # business_day.py) — the plain UTC calendar date would drift from it by
    # up to DAY_BOUNDARY_HOUR minutes once a day, right after the boundary
    # rolls over in IST but before the server's UTC calendar date does too.
    return get_business_date_string()


@router.post("")
async def create_reminder(request: Request, employee: Employee = Depends(get_current_employee)):
    body = await request.json()

    try:
        dealer_id = int(body.get("dealer_id"))
    except (TypeError, ValueError):
        return JSONResponse({"error": "Invalid dealer_id"}, status_code=400)

    reminder_date = body.get("reminder_date")
    if not _is_valid_date_string(reminder_date):
        return JSONResponse({"error": "Invalid reminder_date"}, status_code=400)
    if reminder_date < _today_date_string():
        return JSONResponse({"error": "reminder_date_in_past"}, status_code=422)

    trimmed = _validate_note(body.get("note"))
    if not trimmed:
        return JSONResponse({"error": "note_too_short", "minLength": MIN_NOTE_LENGTH}, status_code=422)

    try:
        dealer = await pool.fetchrow("SELECT id FROM dealers WHERE id = $1", dealer_id)
        if dealer is None:
            return JSONResponse({"error": "Dealer not found"}, status_code=404)

        row = await pool.fetchrow(
            f"""
            INSERT INTO reminders (employee_id, dealer_id, reminder_date, note)
            VALUES ($1, $2, $3, $4) RETURNING {REMINDER_FIELDS}
            """,
            employee.id, dealer_id, parse_date_string(reminder_date), trimmed,
        )
        return JSONResponse({"reminder": serialize_row(row)}, status_code=201)
    except Exception as err:  # noqa: BLE001
        log_error("POST /api/reminders error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.get("")
async def list_reminders(request: Request, employee: Employee = Depends(get_current_employee)):
    is_manager = employee.role == "manager"
    employee_id_param = request.query_params.get("employee_id")

    try:
        target_employee_id = employee.id
        if is_manager and employee_id_param:
            try:
                target_employee_id = int(employee_id_param)
            except ValueError:
                return JSONResponse({"error": "Invalid employee_id"}, status_code=400)

        rows = await pool.fetch(
            """
            SELECT r.id, r.employee_id, r.dealer_id, r.reminder_date, r.note,
                   r.notif_id_day_before, r.notif_id_day_of, r.created_at, d.name AS dealer_name
            FROM reminders r
            JOIN dealers d ON d.id = r.dealer_id
            WHERE r.employee_id = $1
            ORDER BY r.reminder_date ASC LIMIT 500
            """,
            target_employee_id,
        )
        return {"reminders": serialize_rows(rows)}
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/reminders error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.patch("/{reminder_id}/notifications")
async def update_reminder_notifications(
    reminder_id: str, request: Request, employee: Employee = Depends(get_current_employee)
):
    try:
        id_val = int(reminder_id)
    except ValueError:
        return JSONResponse({"error": "Invalid reminder id"}, status_code=400)

    body = await request.json()
    notif_id_day_before = body.get("notif_id_day_before")
    notif_id_day_of = body.get("notif_id_day_of")

    try:
        existing = await pool.fetchrow("SELECT employee_id FROM reminders WHERE id = $1", id_val)
        if existing is None:
            return JSONResponse({"error": "Reminder not found"}, status_code=404)
        if existing["employee_id"] != employee.id:
            return JSONResponse({"error": "Not authorized to edit this reminder"}, status_code=403)

        row = await pool.fetchrow(
            f"""
            UPDATE reminders SET notif_id_day_before = $1, notif_id_day_of = $2
            WHERE id = $3 RETURNING {REMINDER_FIELDS}
            """,
            notif_id_day_before or None, notif_id_day_of or None, id_val,
        )
        return {"reminder": serialize_row(row)}
    except Exception as err:  # noqa: BLE001
        log_error("PATCH /api/reminders/:id/notifications error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.delete("/{reminder_id}")
async def delete_reminder(reminder_id: str, employee: Employee = Depends(get_current_employee)):
    try:
        id_val = int(reminder_id)
    except ValueError:
        return JSONResponse({"error": "Invalid reminder id"}, status_code=400)

    try:
        existing = await pool.fetchrow("SELECT employee_id FROM reminders WHERE id = $1", id_val)
        if existing is None:
            return JSONResponse({"error": "Reminder not found"}, status_code=404)
        if existing["employee_id"] != employee.id:
            return JSONResponse({"error": "Not authorized to delete this reminder"}, status_code=403)

        await pool.execute("DELETE FROM reminders WHERE id = $1", id_val)
        return {"success": True}
    except Exception as err:  # noqa: BLE001
        log_error("DELETE /api/reminders/:id error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)
