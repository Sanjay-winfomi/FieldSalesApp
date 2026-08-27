"""visits.py — ports visits.routes.js exactly (geofencing, staged excursion
alerts, exception review). All routes require auth; /exceptions* also
require manager role."""
import math
from datetime import datetime, timezone

import asyncpg
from fastapi import APIRouter, Depends, Request
from starlette.responses import JSONResponse

from app.core.config import GPS_ACCURACY_THRESHOLD_METERS, LOGIN_MATCH_TOLERANCE_METERS
from app.core.logging_config import log_error, log_warn
from app.core.security import Employee, get_current_employee, require_manager
from app.db import pool
from app.services import idempotency
from app.services.dealer_assignments import mark_assignment_visited
from app.services.google_routes import RoutesApiError, compute_route
from app.services.manager_notifications import create_manager_notification
from app.utils.activity_log import log_dealer_login, log_dealer_logout, log_visit_interrupted
from app.utils.business_day import business_date_expr
from app.utils.haversine import haversine_km
from app.utils.json_shape import serialize_row, serialize_rows
from app.utils.pg_params import parse_date_string

router = APIRouter(dependencies=[Depends(get_current_employee)])

MIN_REASON_LENGTH = 20
LOGOUT_EXCEPTION_REASON_MIN = 50
LOGOUT_EXCEPTION_REASON_MAX = 500
RADIUS_ALERT_STAGE_MINUTES = 10


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
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(n) or n < 0:
        return None
    return n


@router.post("/login")
async def visit_login(request: Request, employee: Employee = Depends(get_current_employee)):
    body = await request.json()
    employee_id = employee.id
    attendance_id = body.get("attendance_id")
    dealer_id = body.get("dealer_id")
    reason = body.get("reason")

    if not attendance_id or not dealer_id or body.get("lat") is None or body.get("lng") is None:
        return JSONResponse({"error": "attendance_id, dealer_id, lat, and lng are required"}, status_code=400)
    lat = _parse_coord(body.get("lat"), -90, 90)
    lng = _parse_coord(body.get("lng"), -180, 180)
    if lat is None or lng is None:
        return JSONResponse({"error": "lat and lng must be valid numbers (-90..90, -180..180)"}, status_code=400)
    accuracy_meters = _parse_accuracy(body.get("accuracy_meters"))
    if accuracy_meters is None:
        return JSONResponse({"error": "accuracy_meters is required"}, status_code=400)
    if accuracy_meters > GPS_ACCURACY_THRESHOLD_METERS:
        return JSONResponse(
            {"error": "gps_accuracy_exceeded", "accuracyMeters": accuracy_meters, "thresholdMeters": GPS_ACCURACY_THRESHOLD_METERS},
            status_code=422,
        )

    idempotency_key = request.headers.get("idempotency-key")

    dealer = visit = None
    inside_radius = True
    trimmed_reason = ""
    distance_m = None

    conn = await pool.get_pool().acquire()
    try:
        cached = await idempotency.get_idempotent_response(idempotency_key, employee_id, "visits/login")
        if cached:
            return JSONResponse(cached["response_body"], status_code=cached["response_status"])

        tx = conn.transaction()
        await tx.start()
        try:
            att = await conn.fetchrow(
                "SELECT id, login_lat, login_lng FROM attendance WHERE id = $1 AND employee_id = $2 AND logout_time IS NULL FOR UPDATE",
                attendance_id, employee_id,
            )
            if att is None:
                await tx.rollback()
                return JSONResponse({"error": "Attendance record not found, or the day has already ended"}, status_code=404)

            open_visit = await conn.fetchrow(
                """
                SELECT cv.id, cv.dealer_id, d.name AS dealer_name
                FROM client_visits cv JOIN dealers d ON d.id = cv.dealer_id
                WHERE cv.attendance_id = $1 AND cv.logout_time IS NULL LIMIT 1
                """,
                attendance_id,
            )
            if open_visit is not None:
                await tx.rollback()
                return JSONResponse(
                    {
                        "error": "visit_already_open",
                        "visit": {"id": open_visit["id"], "dealer_id": open_visit["dealer_id"], "dealer_name": open_visit["dealer_name"]},
                    },
                    status_code=409,
                )

            dealer = await conn.fetchrow("SELECT id, name, latitude, longitude, radius_meters FROM dealers WHERE id = $1", dealer_id)
            if dealer is None:
                await tx.rollback()
                return JSONResponse({"error": "Dealer not found"}, status_code=404)

            inside_radius = True
            distance_m = None
            if dealer["latitude"] is not None and dealer["longitude"] is not None:
                distance_m = haversine_km(float(dealer["latitude"]), float(dealer["longitude"]), lat, lng) * 1000
                inside_radius = distance_m <= dealer["radius_meters"]

            trimmed_reason = reason.strip() if isinstance(reason, str) else ""
            if not inside_radius and len(trimmed_reason) < MIN_REASON_LENGTH:
                await tx.rollback()
                return JSONResponse(
                    {"error": "reason_required", "distanceMeters": distance_m, "minLength": MIN_REASON_LENGTH},
                    status_code=422,
                )

            last_visit = await conn.fetchrow(
                "SELECT logout_lat, logout_lng FROM client_visits WHERE attendance_id = $1 AND logout_time IS NOT NULL ORDER BY logout_time DESC LIMIT 1",
                attendance_id,
            )
            if last_visit is not None and last_visit["logout_lat"] is not None:
                prev_lat = float(last_visit["logout_lat"])
                prev_lng = float(last_visit["logout_lng"])
            else:
                prev_lat = float(att["login_lat"])
                prev_lng = float(att["login_lng"])

            try:
                route = await compute_route(prev_lat, prev_lng, lat, lng)
            except RoutesApiError as route_err:
                log_warn("Routes API failed for dealer-to-dealer leg", error=str(route_err))
                await tx.rollback()
                return JSONResponse({"error": "route_computation_failed", "message": "Request timed out — Retry"}, status_code=502)
            if route.distance_meters is None:
                log_warn("Routes API returned no distance for dealer-to-dealer leg")
                await tx.rollback()
                return JSONResponse({"error": "route_computation_failed", "message": "Request timed out — Retry"}, status_code=502)
            dist_from_prev = route.distance_meters / 1000

            visit = await conn.fetchrow(
                """
                INSERT INTO client_visits
                    (attendance_id, dealer_id, login_time, login_lat, login_lng,
                     distance_from_previous_km, distance_is_routed, login_accuracy_m, login_distance_m,
                     login_inside_radius, login_justification_note, sync_status)
                VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9, $10, 'synced')
                RETURNING id, dealer_id, login_time, login_lat, login_lng, distance_from_previous_km,
                          distance_is_routed, login_distance_m, login_inside_radius
                """,
                attendance_id, dealer_id, lat, lng, dist_from_prev, True, accuracy_meters, distance_m,
                inside_radius, trimmed_reason or None,
            )

            await conn.execute(
                "UPDATE attendance SET total_distance_km = COALESCE(total_distance_km, 0) + $1 WHERE id = $2",
                dist_from_prev, attendance_id,
            )

            if not inside_radius:
                await conn.execute(
                    """
                    INSERT INTO exception_log
                        (employee_id, dealer_id, visit_id, event_type, latitude, longitude, distance_meters, gps_accuracy_m, reason)
                    VALUES ($1, $2, $3, 'login', $4, $5, $6, $7, $8)
                    """,
                    employee_id, dealer_id, visit["id"], lat, lng, distance_m, accuracy_meters, trimmed_reason,
                )

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
        log_error("Visit login error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)
    finally:
        await pool.get_pool().release(conn)

    if not inside_radius:
        await create_manager_notification(
            type="login_exception",
            title="Representative login exception",
            body=f'{employee.username} logged in at {dealer["name"]} from outside the dealer radius (~{round(distance_m)}m away). Reason: "{trimmed_reason}"',
            severity="warning",
            employee_id=employee_id,
            dealer_id=dealer_id,
            visit_id=visit["id"],
        )

    log_dealer_login(employee.username, dealer["name"])
    try:
        await mark_assignment_visited(employee_id, dealer_id)
    except Exception:  # noqa: BLE001
        pass

    visit_dict = serialize_row(visit)
    visit_dict["dealer_name"] = dealer["name"]
    response_body = {"visit": visit_dict}
    await idempotency.save_idempotent_response(idempotency_key, employee_id, "visits/login", 201, response_body)
    return JSONResponse(response_body, status_code=201)


@router.post("/logout")
async def visit_logout(request: Request, employee: Employee = Depends(get_current_employee)):
    body = await request.json()
    employee_id = employee.id
    visit_id = body.get("visit_id")
    reason = body.get("reason")

    if not visit_id or body.get("lat") is None or body.get("lng") is None:
        return JSONResponse({"error": "visit_id, lat, and lng are required"}, status_code=400)
    lat = _parse_coord(body.get("lat"), -90, 90)
    lng = _parse_coord(body.get("lng"), -180, 180)
    if lat is None or lng is None:
        return JSONResponse({"error": "lat and lng must be valid numbers (-90..90, -180..180)"}, status_code=400)
    accuracy_meters = _parse_accuracy(body.get("accuracy_meters"))
    if accuracy_meters is None:
        return JSONResponse({"error": "accuracy_meters is required"}, status_code=400)
    if accuracy_meters > GPS_ACCURACY_THRESHOLD_METERS:
        return JSONResponse(
            {"error": "gps_accuracy_exceeded", "accuracyMeters": accuracy_meters, "thresholdMeters": GPS_ACCURACY_THRESHOLD_METERS},
            status_code=422,
        )

    idempotency_key = request.headers.get("idempotency-key")

    try:
        cached = await idempotency.get_idempotent_response(idempotency_key, employee_id, "visits/logout")
        if cached:
            return JSONResponse(cached["response_body"], status_code=cached["response_status"])

        visit = await pool.fetchrow(
            """
            SELECT cv.id, cv.attendance_id, cv.dealer_id, cv.login_time, cv.logout_time,
                   cv.login_lat, cv.login_lng, cv.login_inside_radius,
                   d.name AS dealer_name, d.latitude AS dealer_lat, d.longitude AS dealer_lng,
                   d.radius_meters AS dealer_radius_meters
            FROM client_visits cv
            JOIN attendance a ON a.id = cv.attendance_id
            JOIN dealers d ON d.id = cv.dealer_id
            WHERE cv.id = $1 AND a.employee_id = $2
            """,
            visit_id, employee_id,
        )
        if visit is None:
            return JSONResponse({"error": "Visit record not found"}, status_code=404)
        if visit["logout_time"] is not None:
            return JSONResponse(
                {"error": "Visit already logged out", "visit": {"id": visit["id"], "logout_time": serialize_row(visit)["logout_time"]}},
                status_code=409,
            )

        distance_m = None
        inside_radius = True
        if visit["dealer_lat"] is not None and visit["dealer_lng"] is not None:
            distance_m = haversine_km(float(visit["dealer_lat"]), float(visit["dealer_lng"]), lat, lng) * 1000
            inside_radius = distance_m <= visit["dealer_radius_meters"]

        matched_login = False
        if not inside_radius and visit["login_lat"] is not None and visit["login_lng"] is not None:
            drift_m = haversine_km(float(visit["login_lat"]), float(visit["login_lng"]), lat, lng) * 1000
            matched_login = drift_m <= LOGIN_MATCH_TOLERANCE_METERS

        trimmed_reason = reason.strip() if isinstance(reason, str) else ""
        login_was_exception = visit["login_inside_radius"] is False
        outside_now = (not inside_radius) and (not matched_login)

        if login_was_exception or outside_now:
            if len(trimmed_reason) < LOGOUT_EXCEPTION_REASON_MIN or len(trimmed_reason) > LOGOUT_EXCEPTION_REASON_MAX:
                return JSONResponse(
                    {
                        "error": "reason_required",
                        "distanceMeters": distance_m,
                        "minLength": LOGOUT_EXCEPTION_REASON_MIN,
                        "maxLength": LOGOUT_EXCEPTION_REASON_MAX,
                    },
                    status_code=422,
                )

        login_time = visit["login_time"]
        logout_time = datetime.now(timezone.utc)
        duration_mins = max(0, round((logout_time - login_time).total_seconds() / 60))
        out_of_radius = not inside_radius

        updated = await pool.fetchrow(
            """
            UPDATE client_visits
            SET logout_time = NOW(), logout_lat = $1, logout_lng = $2,
                visit_duration_minutes = $3, out_of_radius = $4,
                logout_accuracy_m = $5, logout_distance_m = $6,
                matched_login = $7, logout_justification_note = $8
            WHERE id = $9
            RETURNING id, logout_time, visit_duration_minutes, out_of_radius, matched_login
            """,
            lat, lng, duration_mins, out_of_radius, accuracy_meters, distance_m, matched_login,
            trimmed_reason or None, visit_id,
        )

        needs_verification = login_was_exception and out_of_radius

        if out_of_radius:
            await pool.execute(
                """
                INSERT INTO exception_log
                    (employee_id, dealer_id, visit_id, event_type, latitude, longitude, distance_meters, gps_accuracy_m, reason, matched_login)
                VALUES ($1, $2, $3, 'logout', $4, $5, $6, $7, $8, $9)
                """,
                employee_id, visit["dealer_id"], visit_id, lat, lng, distance_m, accuracy_meters,
                trimmed_reason or None, matched_login,
            )
            await create_manager_notification(
                type="needs_verification" if needs_verification else "logout_exception",
                title="Needs Verification" if needs_verification else "Representative logout exception",
                body=(
                    f'{employee.username} used an exception at BOTH login and logout for {visit["dealer_name"]} — please review.'
                    if needs_verification
                    else f'{employee.username} logged out of {visit["dealer_name"]} from outside the dealer radius (~{round(distance_m)}m away). Reason: "{trimmed_reason}"'
                ),
                severity="warning",
                employee_id=employee_id,
                dealer_id=visit["dealer_id"],
                visit_id=visit_id,
            )

        log_dealer_logout(employee.username, visit["dealer_name"], duration_mins, out_of_radius)
        visit_dict = serialize_row(updated)
        visit_dict["needs_verification"] = needs_verification
        response_body = {"visit": visit_dict}
        await idempotency.save_idempotent_response(idempotency_key, employee_id, "visits/logout", 200, response_body)
        return response_body
    except Exception as err:  # noqa: BLE001
        log_error("Visit logout error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.post("/{visit_id}/location-check")
async def location_check(visit_id: str, request: Request, employee: Employee = Depends(get_current_employee)):
    try:
        id_val = int(visit_id)
    except ValueError:
        return JSONResponse({"error": "Invalid visit id"}, status_code=400)

    body = await request.json()
    employee_id = employee.id
    lat = _parse_coord(body.get("lat"), -90, 90)
    lng = _parse_coord(body.get("lng"), -180, 180)
    if lat is None or lng is None:
        return JSONResponse({"error": "lat and lng must be valid numbers (-90..90, -180..180)"}, status_code=400)

    idempotency_key = request.headers.get("idempotency-key")

    try:
        cached = await idempotency.get_idempotent_response(idempotency_key, employee_id, "visits/location-check")
        if cached:
            return JSONResponse(cached["response_body"], status_code=cached["response_status"])

        visit = await pool.fetchrow(
            """
            SELECT cv.id, cv.dealer_id, cv.logout_time, cv.outside_radius_count, cv.log_out_alert_sent,
                   d.name AS dealer_name, d.latitude AS dealer_lat, d.longitude AS dealer_lng, d.radius_meters,
                   e.name AS employee_name
            FROM client_visits cv
            JOIN attendance a ON a.id = cv.attendance_id
            JOIN dealers d ON d.id = cv.dealer_id
            JOIN employees e ON e.id = a.employee_id
            WHERE cv.id = $1 AND a.employee_id = $2
            """,
            id_val, employee_id,
        )
        if visit is None:
            return JSONResponse({"error": "Visit record not found"}, status_code=404)
        if visit["logout_time"] is not None:
            return {"visit": {"id": visit["id"], "logout_time": serialize_row(visit)["logout_time"]}}

        distance_m = None
        inside_radius = True
        if visit["dealer_lat"] is not None and visit["dealer_lng"] is not None:
            distance_m = haversine_km(float(visit["dealer_lat"]), float(visit["dealer_lng"]), lat, lng) * 1000
            inside_radius = distance_m <= visit["radius_meters"]

        status_text = "inside" if inside_radius else "outside"
        updated = await pool.fetchrow(
            """
            WITH old AS (
              SELECT outside_radius_count, log_out_alert_sent, interrupted, interrupted_distance_m
              FROM client_visits WHERE id = $3
            )
            UPDATE client_visits cv
            SET last_location_status     = $1::text,
                last_location_check_at   = NOW(),
                last_location_distance_m = $2,
                outside_radius_count     = CASE WHEN $1::text = 'inside' THEN old.outside_radius_count ELSE old.outside_radius_count + 1 END,
                log_out_alert_sent       = old.log_out_alert_sent OR (
                  $1::text = 'outside' AND NOT old.log_out_alert_sent AND (old.outside_radius_count + 1) >= 2
                ),
                interrupted              = old.interrupted OR (
                  $1::text = 'outside' AND NOT old.log_out_alert_sent AND (old.outside_radius_count + 1) >= 2
                ),
                interrupted_at           = CASE WHEN old.interrupted THEN cv.interrupted_at
                                                WHEN ($1::text = 'outside' AND NOT old.log_out_alert_sent AND (old.outside_radius_count + 1) >= 2) THEN NOW()
                                                ELSE cv.interrupted_at END,
                interrupted_distance_m   = CASE WHEN old.interrupted THEN old.interrupted_distance_m
                                                WHEN ($1::text = 'outside' AND NOT old.log_out_alert_sent AND (old.outside_radius_count + 1) >= 2) THEN $2
                                                ELSE old.interrupted_distance_m END
            FROM old
            WHERE cv.id = $3
            RETURNING cv.id, cv.last_location_status, cv.last_location_check_at, cv.last_location_distance_m,
                      cv.outside_radius_count, cv.log_out_alert_sent, cv.interrupted,
                      (NOT old.log_out_alert_sent AND cv.log_out_alert_sent) AS should_send_logout_alert
            """,
            status_text, distance_m, id_val,
        )

        should_send_logout_alert = updated["should_send_logout_alert"]

        if should_send_logout_alert:
            await pool.execute(
                """
                INSERT INTO exception_log (employee_id, dealer_id, visit_id, event_type, latitude, longitude, distance_meters)
                VALUES ($1, $2, $3, 'interrupted', $4, $5, $6)
                """,
                employee_id, visit["dealer_id"], id_val, lat, lng, distance_m,
            )
            log_visit_interrupted(employee.username, visit["dealer_name"], distance_m)

        rep_notification = None
        open_event = await pool.fetchrow(
            "SELECT id, left_at, alert_count, max_distance_m FROM visit_radius_events WHERE visit_id = $1 AND returned_at IS NULL",
            id_val,
        )

        if not inside_radius:
            if open_event is None:
                try:
                    await pool.execute(
                        """
                        INSERT INTO visit_radius_events (visit_id, employee_id, dealer_id, left_at, alert_count, max_distance_m)
                        VALUES ($1, $2, $3, NOW(), 0, $4)
                        """,
                        id_val, employee_id, visit["dealer_id"], distance_m,
                    )
                except asyncpg.UniqueViolationError:
                    pass
            else:
                minutes_outside = (datetime.now(timezone.utc) - open_event["left_at"]).total_seconds() / 60
                due_stage = int(minutes_outside // RADIUS_ALERT_STAGE_MINUTES)
                new_max_distance = max(open_event["max_distance_m"] or 0, distance_m or 0)
                stage_is_due = due_stage > open_event["alert_count"]
                new_alert_count = open_event["alert_count"] + 1 if stage_is_due else open_event["alert_count"]

                claim_status = await pool.execute(
                    "UPDATE visit_radius_events SET alert_count = $1, max_distance_m = $2 WHERE id = $3 AND alert_count = $4",
                    new_alert_count, new_max_distance, open_event["id"], open_event["alert_count"],
                )
                claimed = claim_status.split()[-1] == "1"

                if stage_is_due and claimed:
                    stage = new_alert_count
                    notify_manager = stage == 1 or stage >= 3
                    notify_rep = stage >= 2

                    if notify_manager:
                        await create_manager_notification(
                            type="left_dealer" if stage == 1 else "still_outside",
                            title="Representative left dealer" if stage == 1 else "Representative still outside",
                            body=(
                                f'{visit["employee_name"]} appears to have left {visit["dealer_name"]}.'
                                if stage == 1
                                else f'{visit["employee_name"]} has been outside {visit["dealer_name"]} for {round(minutes_outside)} minutes.'
                            ),
                            severity="warning",
                            employee_id=employee_id,
                            dealer_id=visit["dealer_id"],
                            visit_id=id_val,
                        )
                    if notify_rep:
                        rep_notification = {
                            "title": "Time to log out?",
                            "body": "You appear to be outside the dealer location. If your visit has ended please complete Dealer Logout.",
                        }
        elif open_event is not None:
            closed_status = await pool.execute(
                "UPDATE visit_radius_events SET returned_at = NOW() WHERE id = $1 AND returned_at IS NULL", open_event["id"]
            )
            if closed_status.split()[-1] == "1" and open_event["alert_count"] > 0:
                await create_manager_notification(
                    type="returned",
                    title="Representative returned",
                    body=f'{visit["employee_name"]} has returned to {visit["dealer_name"]}.',
                    severity="info",
                    employee_id=employee_id,
                    dealer_id=visit["dealer_id"],
                    visit_id=id_val,
                )
                rep_notification = {"title": "Return inside dealer", "body": "You're back inside the dealer premises."}

        visit_fields = serialize_row(updated)
        visit_fields.pop("should_send_logout_alert", None)
        response_body = {"visit": visit_fields, "distance_meters": distance_m, "rep_notification": rep_notification}
        await idempotency.save_idempotent_response(idempotency_key, employee_id, "visits/location-check", 200, response_body)
        return response_body
    except Exception as err:  # noqa: BLE001
        log_error("POST /api/visits/:id/location-check error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.get("")
async def list_visits(request: Request, employee: Employee = Depends(get_current_employee)):
    q = request.query_params
    from_ = q.get("from")
    to = q.get("to")
    dealer_id_param = q.get("dealer_id")
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

        if dealer_id_param:
            try:
                dealer_id_val = int(dealer_id_param)
            except ValueError:
                return JSONResponse({"error": "Invalid dealer_id"}, status_code=400)
            params.append(dealer_id_val)
            conditions.append(f"cv.dealer_id = ${len(params)}")

        if from_:
            params.append(parse_date_string(from_))
            conditions.append(f"{business_date_expr('cv.login_time')} >= ${len(params)}::date")
        if to:
            params.append(parse_date_string(to))
            conditions.append(f"{business_date_expr('cv.login_time')} <= ${len(params)}::date")

        where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        rows = await pool.fetch(
            f"""
            SELECT cv.id, cv.attendance_id, a.employee_id, e.name AS employee_name,
                   cv.dealer_id, d.name AS dealer_name, d.address AS dealer_address,
                   cv.login_time, cv.login_lat, cv.login_lng, cv.login_inside_radius,
                   cv.login_justification_note,
                   cv.logout_time, cv.logout_lat, cv.logout_lng, cv.logout_justification_note,
                   cv.visit_duration_minutes, cv.distance_from_previous_km, cv.distance_is_routed,
                   cv.out_of_radius, cv.interrupted, cv.interrupted_at, cv.sync_status
            FROM client_visits cv
            JOIN attendance a ON a.id = cv.attendance_id
            JOIN dealers d ON d.id = cv.dealer_id
            JOIN employees e ON e.id = a.employee_id
            {where_clause}
            ORDER BY cv.login_time DESC
            LIMIT 1000
            """,
            *params,
        )
        visits = serialize_rows(rows)
        for v, row in zip(visits, rows):
            v["needs_verification"] = row["login_inside_radius"] is False and row["out_of_radius"] is True
        return {"visits": visits}
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/visits error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.get("/exceptions")
async def list_exceptions(request: Request, employee: Employee = Depends(require_manager)):
    q = request.query_params
    employee_id_param = q.get("employee_id")
    dealer_id_param = q.get("dealer_id")
    reviewed_param = q.get("reviewed")
    from_ = q.get("from")
    to = q.get("to")

    try:
        conditions = []
        params: list = []

        if employee_id_param:
            try:
                employee_id_val = int(employee_id_param)
            except ValueError:
                return JSONResponse({"error": "Invalid employee_id"}, status_code=400)
            params.append(employee_id_val)
            conditions.append(f"el.employee_id = ${len(params)}")

        if dealer_id_param:
            try:
                dealer_id_val = int(dealer_id_param)
            except ValueError:
                return JSONResponse({"error": "Invalid dealer_id"}, status_code=400)
            params.append(dealer_id_val)
            conditions.append(f"el.dealer_id = ${len(params)}")

        if reviewed_param is not None:
            params.append(reviewed_param == "true")
            conditions.append(f"el.manager_reviewed = ${len(params)}")

        if from_:
            params.append(parse_date_string(from_))
            conditions.append(f"{business_date_expr('el.created_at')} >= ${len(params)}::date")
        if to:
            params.append(parse_date_string(to))
            conditions.append(f"{business_date_expr('el.created_at')} <= ${len(params)}::date")

        where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        rows = await pool.fetch(
            f"""
            SELECT el.id, el.employee_id, e.name AS employee_name,
                   el.dealer_id, d.name AS dealer_name,
                   el.visit_id, el.event_type, el.latitude, el.longitude,
                   el.distance_meters, el.gps_accuracy_m, el.reason,
                   el.matched_login, el.manager_reviewed, el.created_at,
                   EXISTS (
                     SELECT 1 FROM exception_log el2
                     WHERE el2.visit_id = el.visit_id
                       AND el2.event_type <> el.event_type
                       AND el2.event_type IN ('login', 'logout')
                   ) AS needs_verification
            FROM exception_log el
            JOIN employees e ON e.id = el.employee_id
            JOIN dealers d ON d.id = el.dealer_id
            {where_clause}
            ORDER BY el.created_at DESC
            LIMIT 1000
            """,
            *params,
        )
        return {"exceptions": serialize_rows(rows)}
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/visits/exceptions error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.patch("/exceptions/{exception_id}")
async def patch_exception(exception_id: str, request: Request, employee: Employee = Depends(require_manager)):
    try:
        id_val = int(exception_id)
    except ValueError:
        return JSONResponse({"error": "Invalid exception id"}, status_code=400)

    body = await request.json()
    if "reviewed" in body and body["reviewed"] is not None and not isinstance(body["reviewed"], bool):
        return JSONResponse({"error": "reviewed must be a boolean"}, status_code=400)
    reviewed = body.get("reviewed") is not False

    try:
        row = await pool.fetchrow(
            "UPDATE exception_log SET manager_reviewed = $1 WHERE id = $2 RETURNING id, manager_reviewed",
            reviewed, id_val,
        )
        if row is None:
            return JSONResponse({"error": "Exception record not found"}, status_code=404)
        return {"exception": serialize_row(row)}
    except Exception as err:  # noqa: BLE001
        log_error("PATCH /api/visits/exceptions/:id error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.get("/{visit_id}")
async def get_visit(visit_id: str, employee: Employee = Depends(get_current_employee)):
    try:
        id_val = int(visit_id)
    except ValueError:
        return JSONResponse({"error": "Invalid visit id"}, status_code=400)

    is_manager = employee.role == "manager"

    try:
        record = await pool.fetchrow(
            """
            SELECT cv.id, cv.attendance_id, a.employee_id, e.name AS employee_name,
                   cv.dealer_id, d.name AS dealer_name, d.address AS dealer_address,
                   cv.login_time, cv.login_lat, cv.login_lng, cv.login_inside_radius,
                   cv.login_justification_note,
                   cv.logout_time, cv.logout_lat, cv.logout_lng, cv.logout_justification_note,
                   cv.visit_duration_minutes, cv.distance_from_previous_km, cv.distance_is_routed,
                   cv.out_of_radius, cv.interrupted, cv.interrupted_at, cv.sync_status
            FROM client_visits cv
            JOIN attendance a ON a.id = cv.attendance_id
            JOIN dealers d ON d.id = cv.dealer_id
            JOIN employees e ON e.id = a.employee_id
            WHERE cv.id = $1
            """,
            id_val,
        )
        if record is None:
            return JSONResponse({"error": "Visit record not found"}, status_code=404)
        if not is_manager and record["employee_id"] != employee.id:
            return JSONResponse({"error": "Not authorized to view this record"}, status_code=403)

        result = serialize_row(record)
        result["needs_verification"] = record["login_inside_radius"] is False and record["out_of_radius"] is True
        return {"visit": result}
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/visits/:id error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)
