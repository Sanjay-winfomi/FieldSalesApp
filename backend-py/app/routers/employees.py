"""
employees.py — ports employees.routes.js exactly. Manager-only admin CRUD
for field reps and managers.

GET    /            — list employees (optional ?role=)
POST   /            — create a new employee
PUT    /:id         — update name/phone/region/role/is_active
DELETE /:id         — permanently remove an employee
POST   /:id/reset-password — set a new password
"""
import bcrypt
from fastapi import APIRouter, Depends, Request
from starlette.responses import JSONResponse

from app.core.logging_config import log_error
from app.core.security import Employee, require_manager
from app.db import pool
from app.utils.json_shape import serialize_row, serialize_rows

router = APIRouter(dependencies=[Depends(require_manager)])

PUBLIC_FIELDS = "id, name, phone, username, role, region, is_active, created_at"


@router.get("")
async def list_employees(request: Request, employee: Employee = Depends(require_manager)):
    role = request.query_params.get("role")

    try:
        if role:
            rows = await pool.fetch(
                f"SELECT {PUBLIC_FIELDS} FROM employees WHERE role = $1 ORDER BY name", role
            )
        else:
            rows = await pool.fetch(f"SELECT {PUBLIC_FIELDS} FROM employees ORDER BY name")
        return {"employees": serialize_rows(rows)}
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/employees error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.post("")
async def create_employee(request: Request, employee: Employee = Depends(require_manager)):
    body = await request.json()
    name = body.get("name")
    phone = body.get("phone")
    username = body.get("username")
    password = body.get("password")
    role = body.get("role")
    region = body.get("region")

    if not name or not username or not password or not role:
        return JSONResponse({"error": "name, username, password, and role are required"}, status_code=400)
    if role not in ("rep", "manager"):
        return JSONResponse({"error": "role must be 'rep' or 'manager'"}, status_code=400)
    if len(password) < 6:
        return JSONResponse({"error": "password must be at least 6 characters"}, status_code=400)

    try:
        # Case-insensitive, matching login's case-insensitive lookup — otherwise
        # "Tamil.Kumar" and "tamil.kumar" could exist as two separate accounts.
        existing = await pool.fetchrow(
            "SELECT id FROM employees WHERE LOWER(username) = LOWER($1)", username
        )
        if existing is not None:
            return JSONResponse({"error": "Username already exists"}, status_code=409)

        password_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(10)).decode("utf-8")

        row = await pool.fetchrow(
            f"""
            INSERT INTO employees (name, phone, username, password_hash, role, region)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING {PUBLIC_FIELDS}
            """,
            name, phone or None, username, password_hash, role, region or None,
        )

        return JSONResponse({"employee": serialize_row(row)}, status_code=201)
    except Exception as err:  # noqa: BLE001
        log_error("POST /api/employees error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.put("/{employee_id}")
async def update_employee(employee_id: str, request: Request, employee: Employee = Depends(require_manager)):
    try:
        id_val = int(employee_id)
    except ValueError:
        return JSONResponse({"error": "Invalid employee id"}, status_code=400)

    body = await request.json()
    name = body.get("name")
    phone = body.get("phone")
    region = body.get("region")
    role = body.get("role")
    is_active = body.get("is_active")

    if role and role not in ("rep", "manager"):
        return JSONResponse({"error": "role must be 'rep' or 'manager'"}, status_code=400)
    # `name` in body distinguishes "field omitted" (keep existing) from
    # "explicitly sent" — COALESCE($1, name) below only guards against SQL
    # NULL, not an empty string, so { name: "" } would otherwise blank out a
    # field POST / requires to be non-empty at creation time.
    if "name" in body and not name:
        return JSONResponse({"error": "name cannot be empty"}, status_code=400)

    try:
        existing = await pool.fetchrow(
            "SELECT id, phone, region FROM employees WHERE id = $1", id_val
        )
        if existing is None:
            return JSONResponse({"error": "Employee not found"}, status_code=404)

        # COALESCE can't distinguish "field omitted" from "field explicitly set
        # to null" — so phone/region must use `'key' in body` to allow clearing
        # them, instead of always falling back to the old value.
        next_phone = phone if "phone" in body else existing["phone"]
        next_region = region if "region" in body else existing["region"]

        row = await pool.fetchrow(
            f"""
            UPDATE employees
            SET name      = COALESCE($1, name),
                phone     = $2,
                region    = $3,
                role      = COALESCE($4, role),
                is_active = COALESCE($5, is_active)
            WHERE id = $6
            RETURNING {PUBLIC_FIELDS}
            """,
            name, next_phone if next_phone is not None else None,
            next_region if next_region is not None else None, role, is_active, id_val,
        )

        return {"employee": serialize_row(row)}
    except Exception as err:  # noqa: BLE001
        log_error("PUT /api/employees/:id error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.delete("/{employee_id}")
async def delete_employee(employee_id: str, employee: Employee = Depends(require_manager)):
    try:
        id_val = int(employee_id)
    except ValueError:
        return JSONResponse({"error": "Invalid employee id"}, status_code=400)

    # A manager deleting their own account mid-session would invalidate the
    # token they're using for this very request on the next call — deactivating
    # (or having another manager delete them) is the supported path instead.
    if id_val == employee.id:
        return JSONResponse({"error": "You cannot delete your own account."}, status_code=400)

    try:
        # Deleting an employee cascades to their attendance + client_visits +
        # exception_log rows (ON DELETE CASCADE in schema.sql) — this
        # permanently erases their attendance/visit history, not just the
        # account. Deactivate instead (PUT is_active=false) when the history
        # should be kept.
        row = await pool.fetchrow("DELETE FROM employees WHERE id = $1 RETURNING id", id_val)
        if row is None:
            return JSONResponse({"error": "Employee not found"}, status_code=404)
        return {"success": True}
    except Exception as err:  # noqa: BLE001
        log_error("DELETE /api/employees/:id error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.post("/{employee_id}/reset-password")
async def reset_password(employee_id: str, request: Request, employee: Employee = Depends(require_manager)):
    try:
        id_val = int(employee_id)
    except ValueError:
        return JSONResponse({"error": "Invalid employee id"}, status_code=400)

    body = await request.json()
    password = body.get("password")

    if not password or len(password) < 6:
        return JSONResponse({"error": "password must be at least 6 characters"}, status_code=400)

    try:
        password_hash = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(10)).decode("utf-8")
        row = await pool.fetchrow(
            "UPDATE employees SET password_hash = $1 WHERE id = $2 RETURNING id",
            password_hash, id_val,
        )

        if row is None:
            return JSONResponse({"error": "Employee not found"}, status_code=404)

        return {"success": True}
    except Exception as err:  # noqa: BLE001
        log_error("POST /api/employees/:id/reset-password error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)
