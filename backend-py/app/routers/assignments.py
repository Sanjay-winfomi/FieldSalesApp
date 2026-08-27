"""
assignments.py — ports assignments.routes.js exactly: manager-authored,
ordered dealer visit plans.

GET    /api/assignments        — manager-only: a rep's assignments for a date
PUT    /api/assignments        — manager-only: create/replace/reorder a rep's
                                   ordered dealer list for a date
DELETE /api/assignments/{id}   — manager-only: remove a single dealer from an assignment
GET    /api/assignments/today  — rep-only (implicitly, via employee.id — NO
                                   requireRole in the Node source, confirmed
                                   intentional per INVENTORY.md §8.9)

The sequence here is set exactly once by whichever PUT the manager last
saved — nothing in this file (or anywhere else) ever reorders it. Editing/
removing an assignment never touches client_visits/attendance.
"""
import re
from datetime import datetime

from fastapi import APIRouter, Depends, Request
from starlette.responses import JSONResponse

from app.core.logging_config import log_error
from app.core.security import Employee, get_current_employee, require_manager
from app.db import pool
from app.utils.business_day import business_date_expr
from app.utils.json_shape import serialize_rows

router = APIRouter(dependencies=[Depends(get_current_employee)])

ASSIGNMENT_FIELDS = (
    "da.id, da.employee_id, da.dealer_id, da.assignment_date, da.sequence_order, "
    "da.assigned_by, da.status, da.created_at, da.updated_at"
)


_PARSE_INT_RE = re.compile(r"^\s*[-+]?\d+")


def _parse_int_loose(value):
    """Mirrors JS parseInt(value): leading numeric prefix, else NaN (-> None)."""
    if value is None:
        return None
    m = _PARSE_INT_RE.match(str(value))
    return int(m.group(0)) if m else None


def _is_integer_number(value) -> bool:
    """Mirrors JS Number.isInteger — true for an int, or a float with no
    fractional part (JSON numbers like 5.0 decode to Python float, but are
    integer-valued in JS's single number type)."""
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    if isinstance(value, float):
        return value.is_integer()
    return False


def _parse_date_param(value):
    """Mirrors parseDateParam: None if absent, _INVALID sentinel if an
    unparsable string, else a `datetime.date`.

    Node's version returns the raw string and lets `pg` hand it to Postgres
    (via the query's own `::date` cast) for parsing — asyncpg instead binds
    a `::date`-cast parameter strictly from a native `datetime.date` object
    (verified directly against asyncpg: a string raises `DataError("'str'
    object has no attribute 'toordinal'")` regardless of the cast), so this
    returns the already-parsed date instead of the original string.
    """
    if not value:
        return None
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).date()
        except ValueError:
            pass
        # Date.parse() in JS is far more permissive than datetime.fromisoformat;
        # fall back to a loose parse attempt matching common formats.
        for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%B %d, %Y", "%b %d, %Y"):
            try:
                return datetime.strptime(value, fmt).date()
            except ValueError:
                continue
        return _INVALID
    return _INVALID


class _Invalid:
    pass


_INVALID = _Invalid()


@router.get("")
async def list_assignments(request: Request, employee: Employee = Depends(require_manager)):
    q = request.query_params
    employee_id = _parse_int_loose(q.get("employee_id"))
    if employee_id is None:
        return JSONResponse({"error": "employee_id is required"}, status_code=400)

    date_param = _parse_date_param(q.get("date"))
    if date_param is _INVALID:
        return JSONResponse({"error": "Invalid date"}, status_code=400)

    try:
        rows = await pool.fetch(
            f"""
            SELECT {ASSIGNMENT_FIELDS}, d.name AS dealer_name, d.address AS dealer_address,
                   d.latitude AS dealer_lat, d.longitude AS dealer_lng, d.radius_meters
            FROM dealer_assignments da
            JOIN dealers d ON d.id = da.dealer_id
            WHERE da.employee_id = $1
              AND da.assignment_date = COALESCE($2::date, {business_date_expr('NOW()')})
            ORDER BY da.sequence_order ASC
            """,
            employee_id, date_param,
        )
        return {"assignments": serialize_rows(rows)}
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/assignments error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.put("")
async def put_assignments(request: Request, employee: Employee = Depends(require_manager)):
    body = await request.json()

    employee_id = _parse_int_loose(body.get("employee_id"))
    if employee_id is None:
        return JSONResponse({"error": "employee_id is required"}, status_code=400)

    assignment_date = _parse_date_param(body.get("assignment_date"))
    if not assignment_date or assignment_date is _INVALID:
        return JSONResponse({"error": "assignment_date is required"}, status_code=400)

    dealer_ids = body.get("dealer_ids")
    if not isinstance(dealer_ids, list) or any(not _is_integer_number(d) for d in dealer_ids):
        return JSONResponse({"error": "dealer_ids must be an array of dealer ids"}, status_code=400)
    dealer_ids = [int(d) for d in dealer_ids]

    # Order in the array IS the sequence — de-dup while preserving first
    # occurrence, so a client accidentally sending the same dealer twice
    # doesn't collide on the UNIQUE(employee_id, dealer_id, assignment_date)
    # constraint below.
    ordered_dealer_ids: list[int] = []
    seen = set()
    for d in dealer_ids:
        if d not in seen:
            seen.add(d)
            ordered_dealer_ids.append(d)

    # A transaction, not one autocommit query per statement — without it, a
    # failure partway through the upsert loop left the DB matching neither the
    # old nor new plan, and two concurrent saves for the same employee/date
    # could interleave (one's DELETE running after the other's INSERTs),
    # silently dropping one manager's update.
    conn = await pool.get_pool().acquire()
    try:
        employee_row = await conn.fetchrow(
            "SELECT id FROM employees WHERE id = $1 AND role = 'rep'", employee_id
        )
        if employee_row is None:
            return JSONResponse({"error": "Representative not found"}, status_code=404)

        if ordered_dealer_ids:
            dealer_rows = await conn.fetch(
                "SELECT id FROM dealers WHERE id = ANY($1::int[])", ordered_dealer_ids
            )
            if len(dealer_rows) != len(ordered_dealer_ids):
                return JSONResponse({"error": "One or more dealers not found"}, status_code=404)

        tx = conn.transaction()
        await tx.start()
        try:
            # Transaction-scoped advisory lock keyed by employee_id + date (not a
            # row lock, since a first-ever save for this employee/date has no
            # existing rows to lock) — a concurrent PUT for the same employee/date
            # waits here instead of interleaving its DELETE/INSERTs with ours.
            # Released automatically on COMMIT/ROLLBACK.
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtext(format('dealer_assignments:%s:%s', $1::int, $2::date)))",
                employee_id, assignment_date,
            )

            # Drop anything not in the new list — a manager removing a dealer from
            # the plan is expressed by simply leaving it out of dealer_ids.
            await conn.execute(
                """
                DELETE FROM dealer_assignments
                WHERE employee_id = $1 AND assignment_date = $2::date
                  AND ($3::int[] = '{}' OR NOT (dealer_id = ANY($3::int[])))
                """,
                employee_id, assignment_date, ordered_dealer_ids,
            )

            # Upsert each dealer at its new position. ON CONFLICT deliberately does
            # NOT touch status/created_at — reordering or re-saving an assignment
            # must never reset a dealer that's already been marked completed today.
            for i, dealer_id in enumerate(ordered_dealer_ids):
                await conn.execute(
                    """
                    INSERT INTO dealer_assignments (employee_id, dealer_id, assignment_date, sequence_order, assigned_by)
                    VALUES ($1, $2, $3::date, $4, $5)
                    ON CONFLICT (employee_id, dealer_id, assignment_date)
                    DO UPDATE SET sequence_order = EXCLUDED.sequence_order, updated_at = NOW()
                    """,
                    employee_id, dealer_id, assignment_date, i + 1, employee.id,
                )

            rows = await conn.fetch(
                f"""
                SELECT {ASSIGNMENT_FIELDS}, d.name AS dealer_name, d.address AS dealer_address,
                       d.latitude AS dealer_lat, d.longitude AS dealer_lng, d.radius_meters
                FROM dealer_assignments da
                JOIN dealers d ON d.id = da.dealer_id
                WHERE da.employee_id = $1 AND da.assignment_date = $2::date
                ORDER BY da.sequence_order ASC
                """,
                employee_id, assignment_date,
            )

            await tx.commit()
            return {"assignments": serialize_rows(rows)}
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
        log_error("PUT /api/assignments error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        await pool.get_pool().release(conn)


@router.delete("/{assignment_id}")
async def delete_assignment(assignment_id: str, employee: Employee = Depends(require_manager)):
    id_val = _parse_int_loose(assignment_id)
    if id_val is None:
        return JSONResponse({"error": "Invalid assignment id"}, status_code=400)

    try:
        existing = await pool.fetchrow("SELECT id FROM dealer_assignments WHERE id = $1", id_val)
        if existing is None:
            return JSONResponse({"error": "Assignment not found"}, status_code=404)

        await pool.execute("DELETE FROM dealer_assignments WHERE id = $1", id_val)
        return {"success": True}
    except Exception as err:  # noqa: BLE001
        log_error("DELETE /api/assignments/:id error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


# GET /api/assignments/today — the caller's own assigned dealers for today,
# with the most recent navigation attempt (if any) so the mobile Home card
# can show distance/ETA/status without the rep having to reopen the nav
# screen for something already computed earlier today.
@router.get("/today")
async def get_today_assignments(employee: Employee = Depends(get_current_employee)):
    try:
        rows = await pool.fetch(
            f"""
            SELECT {ASSIGNMENT_FIELDS}, d.name AS dealer_name, d.address AS dealer_address,
                   d.latitude AS dealer_lat, d.longitude AS dealer_lng, d.radius_meters,
                   nav.id AS navigation_id, nav.status AS navigation_status,
                   nav.distance_meters, nav.duration_seconds, nav.duration_in_traffic_seconds,
                   nav.expected_arrival_time
            FROM dealer_assignments da
            JOIN dealers d ON d.id = da.dealer_id
            LEFT JOIN LATERAL (
              SELECT id, status, distance_meters, duration_seconds, duration_in_traffic_seconds, expected_arrival_time
              FROM dealer_navigations
              WHERE assignment_id = da.id
              ORDER BY started_at DESC
              LIMIT 1
            ) nav ON true
            WHERE da.employee_id = $1 AND da.assignment_date = {business_date_expr('NOW()')}
            ORDER BY da.sequence_order ASC
            """,
            employee.id,
        )
        return {"assignments": serialize_rows(rows)}
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/assignments/today error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)
