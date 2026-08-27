"""dealers.py — ports dealers.routes.js exactly (Stage 5 + admin CRUD +
not-visited alert). Any authenticated employee can read; not-visited/POST/
PUT/DELETE are manager-only."""
import math

from fastapi import APIRouter, Depends, Request
from starlette.responses import JSONResponse

from app.core.logging_config import log_error
from app.core.security import Employee, get_current_employee, require_manager
from app.db import pool
from app.services.manager_notifications import create_manager_notification
from app.utils.business_day import get_business_date_string
from app.utils.json_shape import serialize_row, serialize_rows
from app.utils.pg_params import parse_date_string

router = APIRouter(dependencies=[Depends(get_current_employee)])

DEALER_FIELDS = "id, name, address, latitude, longitude, contact_person, contact_phone, radius_meters"
_DEALER_FIELDS_D = "d." + DEALER_FIELDS.replace(", ", ", d.")


def _parse_optional_number(value, lo, hi):
    """Coerces a coordinate/radius field to a finite number within range, or
    returns _MISSING for "not provided" (so callers can distinguish that from
    "provided but invalid") — None/'' pass through as "not provided" since the
    mobile client's forms send those for an intentionally-cleared field."""
    if value is None or value == "":
        return _MISSING
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None  # None = invalid
    if not math.isfinite(n) or n < lo or n > hi:
        return None
    return n


class _Missing:
    def __repr__(self):
        return "MISSING"


_MISSING = _Missing()


@router.get("")
async def list_dealers(request: Request, employee: Employee = Depends(get_current_employee)):
    search = request.query_params.get("search")

    try:
        if search and search.strip():
            # Escape LIKE metacharacters so a literal "%" or "_" in a dealer
            # name (e.g. "100% Fresh Mart") is matched literally instead of
            # acting as a wildcard.
            escaped = search.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            pattern = f"%{escaped}%"
            rows = await pool.fetch(
                f"""
                SELECT {DEALER_FIELDS}
                FROM dealers
                WHERE name ILIKE $1 ESCAPE '\\' OR address ILIKE $1 ESCAPE '\\'
                ORDER BY name
                """,
                pattern,
            )
        else:
            rows = await pool.fetch(f"SELECT {DEALER_FIELDS} FROM dealers ORDER BY name")

        return {"dealers": serialize_rows(rows)}
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/dealers error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.get("/not-visited")
async def not_visited(request: Request, employee: Employee = Depends(require_manager)):
    # `parseInt('0') || 7` treats an explicit days=0 as falsy and silently
    # falls back to the default instead of honoring it (or rejecting it) —
    # check for NaN specifically instead, and reject anything <= 0.
    days_param = request.query_params.get("days")
    if days_param is None:
        days = 7
    else:
        try:
            days = int(days_param)
        except ValueError:
            return JSONResponse({"error": "days must be a positive integer"}, status_code=400)
    if days <= 0:
        return JSONResponse({"error": "days must be a positive integer"}, status_code=400)

    try:
        rows = await pool.fetch(
            f"""
            SELECT {_DEALER_FIELDS_D}, MAX(cv.login_time) AS last_visit_time
            FROM dealers d
            LEFT JOIN client_visits cv ON cv.dealer_id = d.id
            GROUP BY d.id
            HAVING MAX(cv.login_time) IS NULL
                OR MAX(cv.login_time) < NOW() - make_interval(days => $1::int)
            ORDER BY last_visit_time ASC NULLS FIRST
            """,
            days,
        )
        return {"dealers": serialize_rows(rows), "threshold_days": days}
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/dealers/not-visited error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.post("")
async def create_dealer(request: Request, employee: Employee = Depends(require_manager)):
    body = await request.json()
    name = body.get("name")
    address = body.get("address")
    latitude = body.get("latitude")
    longitude = body.get("longitude")
    contact_person = body.get("contact_person")
    contact_phone = body.get("contact_phone")
    radius_meters = body.get("radius_meters")

    if not name:
        return JSONResponse({"error": "name is required"}, status_code=400)

    lat = _parse_optional_number(latitude, -90, 90)
    lng = _parse_optional_number(longitude, -180, 180)
    radius = _parse_optional_number(radius_meters, 1, 100000)
    if lat is None or lng is None:
        return JSONResponse(
            {"error": "latitude and longitude must be valid numbers (-90..90, -180..180)"}, status_code=400
        )
    if radius is None:
        return JSONResponse({"error": "radius_meters must be a positive number"}, status_code=400)

    try:
        row = await pool.fetchrow(
            f"""
            INSERT INTO dealers (name, address, latitude, longitude, contact_person, contact_phone, radius_meters)
            VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 200))
            RETURNING {DEALER_FIELDS}
            """,
            name,
            address or None,
            None if lat is _MISSING else lat,
            None if lng is _MISSING else lng,
            contact_person or None,
            contact_phone or None,
            None if radius is _MISSING else radius,
        )
        return JSONResponse({"dealer": serialize_row(row)}, status_code=201)
    except Exception as err:  # noqa: BLE001
        log_error("POST /api/dealers error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.put("/{dealer_id}")
async def update_dealer(dealer_id: str, request: Request, employee: Employee = Depends(require_manager)):
    try:
        id_val = int(dealer_id)
    except ValueError:
        return JSONResponse({"error": "Invalid dealer id"}, status_code=400)

    body = await request.json()
    name = body.get("name")
    address = body.get("address")
    latitude = body.get("latitude")
    longitude = body.get("longitude")
    contact_person = body.get("contact_person")
    contact_phone = body.get("contact_phone")
    radius_meters = body.get("radius_meters")

    lat = _parse_optional_number(latitude, -90, 90)
    lng = _parse_optional_number(longitude, -180, 180)
    radius = _parse_optional_number(radius_meters, 1, 100000)
    if lat is None or lng is None:
        return JSONResponse(
            {"error": "latitude and longitude must be valid numbers (-90..90, -180..180)"}, status_code=400
        )
    if radius is None:
        return JSONResponse({"error": "radius_meters must be a positive number"}, status_code=400)

    try:
        existing = await pool.fetchrow("SELECT id FROM dealers WHERE id = $1", id_val)
        if existing is None:
            return JSONResponse({"error": "Dealer not found"}, status_code=404)

        row = await pool.fetchrow(
            f"""
            UPDATE dealers
            SET name           = COALESCE($1, name),
                address        = COALESCE($2, address),
                latitude       = COALESCE($3, latitude),
                longitude      = COALESCE($4, longitude),
                contact_person = COALESCE($5, contact_person),
                contact_phone  = COALESCE($6, contact_phone),
                radius_meters  = COALESCE($7, radius_meters)
            WHERE id = $8
            RETURNING {DEALER_FIELDS}
            """,
            name,
            address,
            None if lat is _MISSING else lat,
            None if lng is _MISSING else lng,
            contact_person,
            contact_phone,
            None if radius is _MISSING else radius,
            id_val,
        )
        return {"dealer": serialize_row(row)}
    except Exception as err:  # noqa: BLE001
        log_error("PUT /api/dealers/:id error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.delete("/{dealer_id}")
async def delete_dealer(dealer_id: str, employee: Employee = Depends(require_manager)):
    try:
        id_val = int(dealer_id)
    except ValueError:
        return JSONResponse({"error": "Invalid dealer id"}, status_code=400)

    # The two "what's about to be lost" reads and the DELETE itself run in one
    # transaction so the counts reported back are an exact snapshot of what
    # this DELETE actually removed, not a value that a concurrent write
    # between separate autocommit statements could make stale (e.g. a
    # follow-up request created between the SELECT and the DELETE would
    # otherwise vanish with the cascade but never appear in the notification).
    conn = await pool.get_pool().acquire()
    visit_count = None
    affected_rows = None
    try:
        tx = conn.transaction()
        await tx.start()
        try:
            existing = await conn.fetchrow("SELECT id FROM dealers WHERE id = $1 FOR UPDATE", id_val)
            if existing is None:
                await tx.rollback()
                return JSONResponse({"error": "Dealer not found"}, status_code=404)

            # Deletes cascade (schema.sql) — removing a dealer also permanently
            # removes its visit history, exception records, radius-event
            # history, notifications, and reminders. Counted up front (not to
            # block the delete, just to report what was actually removed)
            # since this is irreversible.
            visit_count_row = await conn.fetchrow(
                "SELECT COUNT(*)::int AS count FROM client_visits WHERE dealer_id = $1", id_val
            )
            visit_count = visit_count_row["count"]

            # A pending follow-up request or a not-yet-completed future
            # assignment for this dealer represents an in-flight workflow a
            # rep is actively waiting on — unlike visit history, silently
            # cascading these away with no trace would leave the rep never
            # finding out why their request/plan vanished. Captured up front
            # so the manager can be told what else this delete took with it.
            affected_rows = await conn.fetch(
                """
                SELECT e.id AS employee_id, e.name AS employee_name
                FROM dealer_followup_requests r
                JOIN employees e ON e.id = r.employee_id
                WHERE r.dealer_id = $1 AND r.status = 'pending'
                UNION
                SELECT e.id AS employee_id, e.name AS employee_name
                FROM dealer_assignments a
                JOIN employees e ON e.id = a.employee_id
                WHERE a.dealer_id = $1 AND a.status NOT IN ('completed', 'cancelled')
                  AND a.assignment_date >= $2::date
                """,
                id_val, parse_date_string(get_business_date_string()),
            )

            await conn.execute("DELETE FROM dealers WHERE id = $1", id_val)
            await tx.commit()
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
        log_error("DELETE /api/dealers/:id error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        await pool.get_pool().release(conn)

    try:
        if len(affected_rows) > 0:
            names = ", ".join(r["employee_name"] for r in affected_rows)
            await create_manager_notification(
                type="dealer_deleted_with_pending_work",
                title="Dealer deleted with pending rep work",
                body=(
                    "Deleting this dealer also removed a pending follow-up request or upcoming "
                    f"assignment for: {names}. Let them know directly, since they won't see any "
                    "notice of this on their own."
                ),
                severity="warning",
            )

        return {"success": True, "deletedVisitCount": visit_count}
    except Exception as err:  # noqa: BLE001
        log_error("DELETE /api/dealers/:id error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)
