"""attendance.py — ports attendance.routes.js exactly."""
import math
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request
from starlette.responses import JSONResponse

from app.core.config import GPS_ACCURACY_THRESHOLD_METERS
from app.core.logging_config import log_error, log_warn
from app.core.security import Employee, get_current_employee
from app.db import pool
from app.services import idempotency
from app.services.dealer_assignments import notify_unvisited_assignments
from app.services.google_routes import RoutesApiError, compute_route
from app.services.manager_notifications import create_manager_notification
from app.utils.activity_log import log_day_login, log_day_logout
from app.utils.business_day import business_date_expr, is_current_business_day
from app.utils.haversine import haversine_km
from app.utils.json_shape import serialize_row, serialize_rows
from app.utils.pg_params import parse_date_string

router = APIRouter(dependencies=[Depends(get_current_employee)])


def _parse_coord(value, lo, hi):
    if value is None:
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(n) or n < lo or n > hi:
        return None
    return n


def _parse_accuracy(value):
    if value is None:
        return _MISSING
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(n) or n < 0:
        return None
    return n


class _Missing:
    def __repr__(self):
        return "MISSING"


_MISSING = _Missing()


@router.post("/login")
async def attendance_login(request: Request, employee: Employee = Depends(get_current_employee)):
    body = await request.json()
    employee_id = employee.id

    work_mode = "office" if body.get("work_mode") == "office" else "field"

    lat = lng = None
    if work_mode == "field":
        if "lat" not in body or "lng" not in body or body.get("lat") is None or body.get("lng") is None:
            return JSONResponse({"error": "lat and lng are required"}, status_code=400)
        lat = _parse_coord(body.get("lat"), -90, 90)
        lng = _parse_coord(body.get("lng"), -180, 180)
        if lat is None or lng is None:
            return JSONResponse({"error": "lat and lng must be valid numbers (-90..90, -180..180)"}, status_code=400)
    elif body.get("lat") is not None or body.get("lng") is not None:
        lat = _parse_coord(body.get("lat"), -90, 90)
        lng = _parse_coord(body.get("lng"), -180, 180)

    accuracy_meters = _parse_accuracy(body.get("accuracy_meters"))
    if accuracy_meters is None:
        return JSONResponse({"error": "accuracy_meters must be a valid non-negative number"}, status_code=400)
    if work_mode == "field" and accuracy_meters is not _MISSING and accuracy_meters > GPS_ACCURACY_THRESHOLD_METERS:
        return JSONResponse(
            {"error": "gps_accuracy_exceeded", "accuracyMeters": accuracy_meters, "thresholdMeters": GPS_ACCURACY_THRESHOLD_METERS},
            status_code=422,
        )

    idempotency_key = request.headers.get("idempotency-key")

    try:
        cached = await idempotency.get_idempotent_response(idempotency_key, employee_id, "attendance/login")
        if cached:
            return JSONResponse(cached["response_body"], status_code=cached["response_status"])

        row = await pool.fetchrow(
            f"""
            INSERT INTO attendance (employee_id, business_date, login_time, login_lat, login_lng, work_mode, sync_status)
            VALUES ($1, {business_date_expr('NOW()')}, NOW(), $2, $3, $4, 'synced')
            ON CONFLICT (employee_id, business_date) WHERE business_date IS NOT NULL DO NOTHING
            RETURNING id, login_time, login_lat, login_lng, work_mode
            """,
            employee_id, lat, lng, work_mode,
        )

        if row is None:
            existing = await pool.fetchrow(
                f"SELECT id FROM attendance WHERE employee_id = $1 AND business_date = {business_date_expr('NOW()')} LIMIT 1",
                employee_id,
            )
            return JSONResponse(
                {"error": "Already logged in today", "attendance_id": existing["id"] if existing else None},
                status_code=409,
            )

        log_day_login(employee.username, lat, lng)

        if work_mode == "office":
            try:
                await create_manager_notification(
                    type="office_day",
                    title="Office day",
                    body=f"{employee.username} marked today as an office day — not visiting dealers.",
                    severity="info",
                    employee_id=employee_id,
                )
            except Exception:  # noqa: BLE001
                pass

        response_body = {"attendance": serialize_row(row)}
        await idempotency.save_idempotent_response(idempotency_key, employee_id, "attendance/login", 201, response_body)
        return JSONResponse(response_body, status_code=201)
    except Exception as err:  # noqa: BLE001
        log_error("Attendance login error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.post("/logout")
async def attendance_logout(request: Request, employee: Employee = Depends(get_current_employee)):
    body = await request.json()
    employee_id = employee.id
    attendance_id = body.get("attendance_id")

    if not attendance_id or body.get("lat") is None or body.get("lng") is None:
        return JSONResponse({"error": "attendance_id, lat, and lng are required"}, status_code=400)
    lat = _parse_coord(body.get("lat"), -90, 90)
    lng = _parse_coord(body.get("lng"), -180, 180)
    if lat is None or lng is None:
        return JSONResponse({"error": "lat and lng must be valid numbers (-90..90, -180..180)"}, status_code=400)
    accuracy_meters = _parse_accuracy(body.get("accuracy_meters"))
    if accuracy_meters is None:
        return JSONResponse({"error": "accuracy_meters must be a valid non-negative number"}, status_code=400)

    idempotency_key = request.headers.get("idempotency-key")

    cached = await idempotency.get_idempotent_response(idempotency_key, employee_id, "attendance/logout")
    if cached:
        return JSONResponse(cached["response_body"], status_code=cached["response_status"])

    auto_closed_visit = None
    response_body = None
    duration_mins = None

    conn = await pool.get_pool().acquire()
    try:
        tx = conn.transaction()
        await tx.start()
        try:
            att = await conn.fetchrow(
                """
                SELECT id, login_time, login_lat, login_lng, logout_time, total_distance_km, work_mode
                FROM attendance WHERE id = $1 AND employee_id = $2 FOR UPDATE
                """,
                attendance_id, employee_id,
            )

            if att is None:
                await tx.rollback()
                return JSONResponse({"error": "Attendance record not found"}, status_code=404)
            if att["login_time"] is None:
                await tx.rollback()
                return JSONResponse({"error": "No login time recorded"}, status_code=400)
            if att["logout_time"] is not None:
                await tx.rollback()
                return JSONResponse(
                    {"error": "Already logged out today", "attendance": serialize_row({"id": att["id"], "logout_time": att["logout_time"]})},
                    status_code=409,
                )
            if att["work_mode"] == "field" and accuracy_meters is not _MISSING and accuracy_meters > GPS_ACCURACY_THRESHOLD_METERS:
                await tx.rollback()
                return JSONResponse(
                    {"error": "gps_accuracy_exceeded", "accuracyMeters": accuracy_meters, "thresholdMeters": GPS_ACCURACY_THRESHOLD_METERS},
                    status_code=422,
                )

            login_time = att["login_time"]
            logout_time = datetime.now(timezone.utc)
            duration_mins = max(0, round((logout_time - login_time).total_seconds() / 60))

            open_visit = await conn.fetchrow(
                """
                SELECT cv.id, cv.dealer_id, cv.login_time, d.name AS dealer_name,
                       d.latitude AS dealer_lat, d.longitude AS dealer_lng, d.radius_meters AS dealer_radius_meters
                FROM client_visits cv
                JOIN dealers d ON d.id = cv.dealer_id
                WHERE cv.attendance_id = $1 AND cv.logout_time IS NULL
                LIMIT 1
                """,
                attendance_id,
            )
            if open_visit is not None:
                visit_duration_mins = round((logout_time - open_visit["login_time"]).total_seconds() / 60)
                visit_out_of_radius = False
                if open_visit["dealer_lat"] is not None and open_visit["dealer_lng"] is not None:
                    visit_distance_m = haversine_km(float(open_visit["dealer_lat"]), float(open_visit["dealer_lng"]), lat, lng) * 1000
                    visit_out_of_radius = visit_distance_m > open_visit["dealer_radius_meters"]

                auto_close_status = await conn.execute(
                    """
                    UPDATE client_visits
                    SET logout_time = NOW(), logout_lat = $1, logout_lng = $2,
                        visit_duration_minutes = $3, out_of_radius = $4,
                        logout_justification_note = $5
                    WHERE id = $6 AND logout_time IS NULL
                    """,
                    lat, lng, visit_duration_mins, visit_out_of_radius,
                    "Auto-closed: day ended while still logged in at this dealer", open_visit["id"],
                )
                if auto_close_status.split()[-1] == "1":
                    auto_closed_visit = open_visit

            last_visit = await conn.fetchrow(
                """
                SELECT logout_lat, logout_lng FROM client_visits
                WHERE attendance_id = $1 AND logout_time IS NOT NULL
                ORDER BY logout_time DESC LIMIT 1
                """,
                attendance_id,
            )
            if last_visit is not None and last_visit["logout_lat"] is not None:
                final_leg_origin_lat = float(last_visit["logout_lat"])
                final_leg_origin_lng = float(last_visit["logout_lng"])
            else:
                final_leg_origin_lat = float(att["login_lat"]) if att["login_lat"] is not None else None
                final_leg_origin_lng = float(att["login_lng"]) if att["login_lng"] is not None else None

            final_leg_distance_km = None
            final_leg_is_routed = False
            if final_leg_origin_lat is not None and math.isfinite(final_leg_origin_lat) and final_leg_origin_lng is not None and math.isfinite(final_leg_origin_lng):
                try:
                    route = await compute_route(final_leg_origin_lat, final_leg_origin_lng, lat, lng)
                except RoutesApiError as route_err:
                    log_warn("Routes API failed for final leg", error=str(route_err))
                    await tx.rollback()
                    return JSONResponse({"error": "route_computation_failed", "message": "Request timed out — Retry"}, status_code=502)
                if route.distance_meters is None:
                    log_warn("Routes API returned no distance for final leg")
                    await tx.rollback()
                    return JSONResponse({"error": "route_computation_failed", "message": "Request timed out — Retry"}, status_code=502)
                final_leg_distance_km = route.distance_meters / 1000
                final_leg_is_routed = True

            result = await conn.fetchrow(
                """
                UPDATE attendance
                SET logout_time = NOW(), logout_lat = $1, logout_lng = $2,
                    total_duration_minutes = $3,
                    total_distance_km = COALESCE(total_distance_km, 0) + COALESCE($5::double precision, 0),
                    final_leg_distance_km = $5::double precision,
                    final_leg_is_routed = $6
                WHERE id = $4 AND logout_time IS NULL
                RETURNING id, login_time, logout_time, total_distance_km, total_duration_minutes,
                          final_leg_distance_km, final_leg_is_routed, work_mode
                """,
                lat, lng, duration_mins, attendance_id, final_leg_distance_km, final_leg_is_routed,
            )

            if result is None:
                await tx.rollback()
                authoritative = await pool.fetchrow("SELECT id, logout_time FROM attendance WHERE id = $1", attendance_id)
                return JSONResponse(
                    {"error": "Already logged out today", "attendance": serialize_row(authoritative)},
                    status_code=409,
                )

            visits_count_row = await conn.fetchrow(
                "SELECT COUNT(*) AS visits_count FROM client_visits WHERE attendance_id = $1", attendance_id
            )

            await tx.commit()

            response_body = {
                "attendance": serialize_row(result),
                "summary": {
                    "visits_count": visits_count_row["visits_count"],
                    "total_distance_km": float(result["total_distance_km"] or 0),
                    "total_duration_min": duration_mins,
                },
            }
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
        log_error("Attendance logout error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        await pool.get_pool().release(conn)

    if auto_closed_visit is not None:
        await create_manager_notification(
            type="visit_auto_closed_on_day_logout",
            title="Dealer visit auto-closed at day logout",
            body=f"{employee.username} ended their day while still logged in at {auto_closed_visit['dealer_name']} — the visit was automatically closed.",
            severity="warning",
            employee_id=employee_id,
            dealer_id=auto_closed_visit["dealer_id"],
            visit_id=auto_closed_visit["id"],
        )

    log_day_logout(employee.username, duration_mins, response_body["attendance"]["total_distance_km"])
    try:
        await notify_unvisited_assignments(employee_id)
    except Exception:  # noqa: BLE001
        pass
    await idempotency.save_idempotent_response(idempotency_key, employee_id, "attendance/logout", 200, response_body)
    return response_body


@router.get("/today")
async def attendance_today(employee: Employee = Depends(get_current_employee)):
    try:
        att = await pool.fetchrow(
            f"""
            SELECT id, login_time, login_lat, login_lng,
                   logout_time, logout_lat, logout_lng,
                   total_distance_km, total_duration_minutes,
                   final_leg_distance_km, final_leg_is_routed, work_mode, sync_status
            FROM attendance
            WHERE employee_id = $1 AND {is_current_business_day('login_time')}
            LIMIT 1
            """,
            employee.id,
        )
        if att is None:
            return {"attendance": None, "visits": []}

        visits = await pool.fetch(
            """
            SELECT cv.id, cv.dealer_id, d.name AS dealer_name, d.address AS dealer_address,
                   d.latitude AS dealer_lat, d.longitude AS dealer_lng, d.radius_meters AS dealer_radius_meters,
                   cv.login_time, cv.login_lat, cv.login_lng, cv.login_inside_radius, cv.logout_time,
                   cv.visit_duration_minutes, cv.distance_from_previous_km, cv.distance_is_routed,
                   cv.out_of_radius, cv.interrupted, cv.interrupted_at,
                   cv.login_justification_note, cv.sync_status
            FROM client_visits cv
            JOIN dealers d ON d.id = cv.dealer_id
            WHERE cv.attendance_id = $1
            ORDER BY cv.login_time
            """,
            att["id"],
        )
        return {"attendance": serialize_row(att), "visits": serialize_rows(visits)}
    except Exception as err:  # noqa: BLE001
        log_error("GET today error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.get("")
async def list_attendance(request: Request, employee: Employee = Depends(get_current_employee)):
    q = request.query_params
    from_ = q.get("from")
    to = q.get("to")
    employee_id_param = q.get("employee_id")
    is_manager = employee.role == "manager"

    try:
        conditions = []
        params: list = []

        if is_manager:
            if employee_id_param:
                try:
                    employee_id_val = int(employee_id_param)
                except ValueError:
                    return JSONResponse({"error": "Invalid employee_id"}, status_code=400)
                params.append(employee_id_val)
                conditions.append(f"a.employee_id = ${len(params)}")
        else:
            params.append(employee.id)
            conditions.append(f"a.employee_id = ${len(params)}")

        if from_:
            params.append(parse_date_string(from_))
            conditions.append(f"{business_date_expr('a.login_time')} >= ${len(params)}::date")
        if to:
            params.append(parse_date_string(to))
            conditions.append(f"{business_date_expr('a.login_time')} <= ${len(params)}::date")

        where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        rows = await pool.fetch(
            f"""
            SELECT a.id, a.employee_id, e.name AS employee_name,
                   a.login_time, a.login_lat, a.login_lng,
                   a.logout_time, a.logout_lat, a.logout_lng,
                   a.total_distance_km, a.total_duration_minutes,
                   a.final_leg_distance_km, a.final_leg_is_routed, a.sync_status
            FROM attendance a
            JOIN employees e ON e.id = a.employee_id
            {where_clause}
            ORDER BY a.login_time DESC
            LIMIT 1000
            """,
            *params,
        )
        return {"attendance": serialize_rows(rows)}
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/attendance error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.get("/{attendance_id}")
async def get_attendance(attendance_id: str, employee: Employee = Depends(get_current_employee)):
    try:
        id_val = int(attendance_id)
    except ValueError:
        return JSONResponse({"error": "Invalid attendance id"}, status_code=400)

    is_manager = employee.role == "manager"

    try:
        record = await pool.fetchrow(
            """
            SELECT a.id, a.employee_id, e.name AS employee_name,
                   a.login_time, a.login_lat, a.login_lng,
                   a.logout_time, a.logout_lat, a.logout_lng,
                   a.total_distance_km, a.total_duration_minutes,
                   a.final_leg_distance_km, a.final_leg_is_routed, a.sync_status
            FROM attendance a
            JOIN employees e ON e.id = a.employee_id
            WHERE a.id = $1
            """,
            id_val,
        )
        if record is None:
            return JSONResponse({"error": "Attendance record not found"}, status_code=404)
        if not is_manager and record["employee_id"] != employee.id:
            return JSONResponse({"error": "Not authorized to view this record"}, status_code=403)
        return {"attendance": serialize_row(record)}
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/attendance/:id error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)
