"""notes.py — ports notes.routes.js exactly (free-form notepad entries).
Any authenticated employee; owner-only enforcement on PUT/DELETE (a manager
may view another rep's notes via ?employee_id=/GET :id, but may NOT edit or
delete them — see PUT/DELETE below, which check req.employee.id regardless
of role)."""
from fastapi import APIRouter, Depends, Request
from starlette.responses import JSONResponse

from app.core.logging_config import log_error
from app.core.security import Employee, get_current_employee
from app.db import pool
from app.utils.json_shape import serialize_row, serialize_rows

router = APIRouter(dependencies=[Depends(get_current_employee)])

MIN_CONTENT_LENGTH = 100
NOTE_FIELDS = "id, employee_id, content, created_at, updated_at"


def _validate_content(content) -> str | None:
    if not isinstance(content, str):
        return None
    trimmed = content.strip()
    return trimmed if len(trimmed) >= MIN_CONTENT_LENGTH else None


@router.post("")
async def create_note(request: Request, employee: Employee = Depends(get_current_employee)):
    body = await request.json()
    trimmed = _validate_content(body.get("content"))
    if not trimmed:
        return JSONResponse({"error": "content_too_short", "minLength": MIN_CONTENT_LENGTH}, status_code=422)

    try:
        row = await pool.fetchrow(
            f"INSERT INTO notes (employee_id, content) VALUES ($1, $2) RETURNING {NOTE_FIELDS}",
            employee.id, trimmed,
        )
        return JSONResponse({"note": serialize_row(row)}, status_code=201)
    except Exception as err:  # noqa: BLE001
        log_error("POST /api/notes error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.get("")
async def list_notes(request: Request, employee: Employee = Depends(get_current_employee)):
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
            f"SELECT {NOTE_FIELDS} FROM notes WHERE employee_id = $1 ORDER BY updated_at DESC LIMIT 500",
            target_employee_id,
        )
        return {"notes": serialize_rows(rows)}
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/notes error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.get("/{note_id}")
async def get_note(note_id: str, employee: Employee = Depends(get_current_employee)):
    try:
        id_val = int(note_id)
    except ValueError:
        return JSONResponse({"error": "Invalid note id"}, status_code=400)

    try:
        row = await pool.fetchrow(f"SELECT {NOTE_FIELDS} FROM notes WHERE id = $1", id_val)
        if row is None:
            return JSONResponse({"error": "Note not found"}, status_code=404)

        is_manager = employee.role == "manager"
        if not is_manager and row["employee_id"] != employee.id:
            return JSONResponse({"error": "Not authorized to view this note"}, status_code=403)

        return {"note": serialize_row(row)}
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/notes/:id error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.put("/{note_id}")
async def update_note(note_id: str, request: Request, employee: Employee = Depends(get_current_employee)):
    try:
        id_val = int(note_id)
    except ValueError:
        return JSONResponse({"error": "Invalid note id"}, status_code=400)

    body = await request.json()
    trimmed = _validate_content(body.get("content"))
    if not trimmed:
        return JSONResponse({"error": "content_too_short", "minLength": MIN_CONTENT_LENGTH}, status_code=422)

    try:
        existing = await pool.fetchrow("SELECT employee_id FROM notes WHERE id = $1", id_val)
        if existing is None:
            return JSONResponse({"error": "Note not found"}, status_code=404)
        if existing["employee_id"] != employee.id:
            return JSONResponse({"error": "Not authorized to edit this note"}, status_code=403)

        row = await pool.fetchrow(
            f"UPDATE notes SET content = $1, updated_at = NOW() WHERE id = $2 RETURNING {NOTE_FIELDS}",
            trimmed, id_val,
        )
        return {"note": serialize_row(row)}
    except Exception as err:  # noqa: BLE001
        log_error("PUT /api/notes/:id error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.delete("/{note_id}")
async def delete_note(note_id: str, employee: Employee = Depends(get_current_employee)):
    try:
        id_val = int(note_id)
    except ValueError:
        return JSONResponse({"error": "Invalid note id"}, status_code=400)

    try:
        existing = await pool.fetchrow("SELECT employee_id FROM notes WHERE id = $1", id_val)
        if existing is None:
            return JSONResponse({"error": "Note not found"}, status_code=404)
        if existing["employee_id"] != employee.id:
            return JSONResponse({"error": "Not authorized to delete this note"}, status_code=403)

        await pool.execute("DELETE FROM notes WHERE id = $1", id_val)
        return {"success": True}
    except Exception as err:  # noqa: BLE001
        log_error("DELETE /api/notes/:id error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)
