"""
dashboard.py — ports dashboard.routes.js exactly (Stage 10). Manager-only.

GET /today   — all reps' current status for today
GET /rep/:id/today — one rep's attendance + visits for today
GET /map     — dealer + rep locations for the manager map view
"""
import asyncio
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends
from starlette.responses import JSONResponse

from app.core.logging_config import log_error
from app.core.security import Employee, require_manager
from app.db import pool
from app.utils.business_day import business_date_expr, is_current_business_day
from app.utils.json_shape import iso_z, serialize_row, serialize_rows

router = APIRouter(dependencies=[Depends(require_manager)])

IST = ZoneInfo("Asia/Kolkata")


def _parse_float_or_none(value):
    """Unconditional parseFloat(value) whose failure/None mirrors NaN --
    JSON.stringify(NaN) on the Node side serializes to `null`, not a NaN
    token, so returning None here (-> JSON null) is the faithful port, not a
    crash guard."""
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_float_truthy(value):
    """Mirrors `value ? parseFloat(value) : null` -- JS truthy check, so an
    exact 0/0.0 is (perhaps buggily) treated the same as null/undefined and
    maps to None too. Ported as-is, not fixed."""
    if not value:
        return None
    return _parse_float_or_none(value)


def _format_ist_time(value: datetime) -> str:
    """Mirrors `new Date(value).toLocaleTimeString('en-IN', { hour: '2-digit',
    minute: '2-digit', timeZone: 'Asia/Kolkata' })` -- zero-padded 12-hour
    clock with a lowercase am/pm suffix (en-IN's short time pattern)."""
    ist = value.astimezone(IST)
    hour12 = ist.hour % 12
    if hour12 == 0:
        hour12 = 12
    period = "am" if ist.hour < 12 else "pm"
    return f"{hour12:02d}:{ist.minute:02d} {period}"


@router.get("/today")
async def dashboard_today(employee: Employee = Depends(require_manager)):
    try:
        rows = await pool.fetch(
            f"""
            SELECT
              e.id            AS employee_id,
              e.name,
              e.region,
              a.id            AS attendance_id,
              a.login_time,
              a.logout_time,
              a.total_distance_km,
              a.work_mode,
              a.sync_status   AS day_sync_status,
              lv.dealer_name,
              lv.login_time  AS visit_login,
              lv.logout_time AS visit_logout,
              lv.login_lat   AS last_lat,
              lv.login_lng   AS last_lng,
              (lv.logout_time IS NULL AND lv.log_out_alert_sent) AS needs_logout_alert,
              (SELECT COUNT(*) FROM client_visits cv2 WHERE cv2.attendance_id = a.id) AS visits_count
            FROM employees e
            LEFT JOIN attendance a
              ON a.employee_id = e.id
              AND {is_current_business_day('a.login_time')}
            LEFT JOIN LATERAL (
              SELECT cv.login_time, cv.logout_time, cv.login_lat, cv.login_lng,
                     cv.log_out_alert_sent, d.name AS dealer_name
              FROM client_visits cv
              JOIN dealers d ON d.id = cv.dealer_id
              WHERE cv.attendance_id = a.id
              ORDER BY cv.login_time DESC
              LIMIT 1
            ) lv ON true
            WHERE e.role = 'rep'
            ORDER BY e.name
            """
        )

        reps = []
        for row in rows:
            if row["attendance_id"] is None:
                status = "not_logged_in"
                last_activity = "Not logged in yet"
                timestamp = None
            elif row["logout_time"] is not None:
                status = "day_ended"
                last_activity = f"Office logout, {_format_ist_time(row['logout_time'])}"
                timestamp = row["logout_time"]
            elif row["visit_login"] is not None and row["visit_logout"] is None:
                status = "logged_in"
                last_activity = f"At {row['dealer_name']}"
                timestamp = row["visit_login"]
            elif row["dealer_name"] is not None:
                status = "logged_in"
                last_activity = f"Travelling from {row['dealer_name']}"
                timestamp = row["visit_logout"]
            elif row["work_mode"] == "office":
                status = "logged_in"
                last_activity = "At office today"
                timestamp = row["login_time"]
            else:
                status = "logged_in"
                last_activity = "Logged in — no visits yet"
                timestamp = row["login_time"]

            reps.append({
                "id": row["employee_id"],
                "name": row["name"],
                "region": row["region"],
                "status": status,
                "last_activity": last_activity,
                "last_updated": iso_z(timestamp) if timestamp is not None else None,
                "visits_count": int(row["visits_count"] or 0),
                "total_distance_km": float(row["total_distance_km"] or 0),
                "last_lat": _parse_float_truthy(row["last_lat"]),
                "last_lng": _parse_float_truthy(row["last_lng"]),
                "day_sync_status": row["day_sync_status"] or "pending",
                "needs_logout_alert": row["needs_logout_alert"] is True,
            })

        return {"reps": reps, "generated_at": iso_z(datetime.now(timezone.utc))}
    except Exception as err:  # noqa: BLE001
        log_error("Dashboard error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.get("/rep/{rep_id}/today")
async def dashboard_rep_today(rep_id: str, employee: Employee = Depends(require_manager)):
    try:
        rep_id_val = int(rep_id)
    except ValueError:
        return JSONResponse({"error": "Invalid rep id"}, status_code=400)

    try:
        emp_row = await pool.fetchrow(
            "SELECT id, name, phone, username, region FROM employees WHERE id = $1 AND role = 'rep'",
            rep_id_val,
        )
        if emp_row is None:
            return JSONResponse({"error": "Representative not found"}, status_code=404)

        employee_dict = serialize_row(emp_row)

        att_row = await pool.fetchrow(
            f"""
            SELECT id, login_time, login_lat, login_lng,
                   logout_time, logout_lat, logout_lng,
                   total_distance_km, total_duration_minutes, work_mode, sync_status
            FROM attendance
            WHERE employee_id = $1
              AND {is_current_business_day('login_time')}
            LIMIT 1
            """,
            rep_id_val,
        )

        if att_row is None:
            return {"employee": employee_dict, "attendance": None, "visits": []}

        visits_rows = await pool.fetch(
            """
            SELECT cv.id, cv.dealer_id, d.name AS dealer_name, d.address AS dealer_address,
                   d.latitude AS dealer_lat, d.longitude AS dealer_lng, d.radius_meters,
                   cv.login_time, cv.login_lat, cv.login_lng,
                   cv.logout_time, cv.logout_lat, cv.logout_lng,
                   cv.visit_duration_minutes, cv.distance_from_previous_km,
                   cv.login_distance_m, cv.login_inside_radius,
                   cv.login_justification_note, cv.logout_justification_note,
                   cv.last_location_status, cv.last_location_check_at, cv.last_location_distance_m,
                   cv.outside_radius_count, cv.log_out_alert_sent, cv.interrupted, cv.interrupted_at,
                   cv.sync_status, vre.left_at AS radius_left_at
            FROM client_visits cv
            JOIN dealers d ON d.id = cv.dealer_id
            LEFT JOIN visit_radius_events vre ON vre.visit_id = cv.id AND vre.returned_at IS NULL
            WHERE cv.attendance_id = $1
            ORDER BY cv.login_time DESC
            """,
            att_row["id"],
        )

        return {
            "employee": employee_dict,
            "attendance": serialize_row(att_row),
            "visits": serialize_rows(visits_rows),
        }
    except Exception as err:  # noqa: BLE001
        log_error("Fetch rep details error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.get("/map")
async def dashboard_map(employee: Employee = Depends(require_manager)):
    try:
        dealers_rows, reps_rows = await asyncio.gather(
            pool.fetch(
                """
                SELECT
                  d.id, d.name, d.address, d.latitude, d.longitude,
                  lv.login_time  AS last_visit_time,
                  lv.logout_time AS last_visit_logout_time,
                  lv.rep_name    AS last_visit_rep_name
                FROM dealers d
                LEFT JOIN LATERAL (
                  SELECT cv.login_time, cv.logout_time, e.name AS rep_name
                  FROM client_visits cv
                  JOIN attendance a ON a.id = cv.attendance_id
                  JOIN employees e  ON e.id = a.employee_id
                  WHERE cv.dealer_id = d.id
                  ORDER BY cv.login_time DESC
                  LIMIT 1
                ) lv ON true
                WHERE d.latitude IS NOT NULL AND d.longitude IS NOT NULL
                ORDER BY d.name
                """
            ),
            pool.fetch(
                f"""
                SELECT
                  e.id AS employee_id, e.name, e.region,
                  a.id AS attendance_id, a.login_lat, a.login_lng,
                  lv.dealer_name  AS last_dealer_name,
                  lv.login_time   AS last_visit_time,
                  lv.login_lat    AS last_lat,
                  lv.login_lng    AS last_lng,
                  na.dealer_name  AS next_dealer_name,
                  na.dealer_lat   AS next_dealer_lat,
                  na.dealer_lng   AS next_dealer_lng,
                  na.sequence_order AS next_sequence_order
                FROM employees e
                LEFT JOIN attendance a
                  ON a.employee_id = e.id
                  AND {is_current_business_day('a.login_time')}
                LEFT JOIN LATERAL (
                  SELECT cv.login_time, cv.login_lat, cv.login_lng, d.name AS dealer_name
                  FROM client_visits cv
                  JOIN dealers d ON d.id = cv.dealer_id
                  WHERE cv.attendance_id = a.id
                  ORDER BY cv.login_time DESC
                  LIMIT 1
                ) lv ON true
                LEFT JOIN LATERAL (
                  SELECT d.name AS dealer_name, d.latitude AS dealer_lat, d.longitude AS dealer_lng,
                         da.sequence_order
                  FROM dealer_assignments da
                  JOIN dealers d ON d.id = da.dealer_id
                  WHERE da.employee_id = e.id
                    AND da.assignment_date = {business_date_expr('NOW()')}
                    AND da.status IN ('pending', 'navigating')
                  ORDER BY da.sequence_order ASC
                  LIMIT 1
                ) na ON true
                WHERE e.role = 'rep'
                ORDER BY e.name
                """
            ),
        )

        dealers = []
        for row in dealers_rows:
            dealers.append({
                "id": row["id"],
                "name": row["name"],
                "address": row["address"],
                "latitude": float(row["latitude"]),
                "longitude": float(row["longitude"]),
                "last_visit": {
                    "rep_name": row["last_visit_rep_name"],
                    "login_time": iso_z(row["last_visit_time"]),
                    "logout_time": iso_z(row["last_visit_logout_time"]) if row["last_visit_logout_time"] is not None else None,
                } if row["last_visit_time"] is not None else None,
            })

        reps = []
        for row in reps_rows:
            lat = row["last_lat"] if row["last_lat"] is not None else row["login_lat"]
            lng = row["last_lng"] if row["last_lng"] is not None else row["login_lng"]
            reps.append({
                "id": row["employee_id"],
                "name": row["name"],
                "region": row["region"],
                "latitude": _parse_float_truthy(lat),
                "longitude": _parse_float_truthy(lng),
                "last_dealer": {
                    "name": row["last_dealer_name"],
                    "visit_time": iso_z(row["last_visit_time"]) if row["last_visit_time"] is not None else None,
                } if row["last_dealer_name"] else None,
                "next_assignment": {
                    "dealer_name": row["next_dealer_name"],
                    "latitude": _parse_float_or_none(row["next_dealer_lat"]),
                    "longitude": _parse_float_or_none(row["next_dealer_lng"]),
                } if row["next_dealer_name"] else None,
            })

        reps = [r for r in reps if r["latitude"] is not None and r["longitude"] is not None]

        return {
            "dealers": dealers,
            "reps": reps,
            "generated_at": iso_z(datetime.now(timezone.utc)),
        }
    except Exception as err:  # noqa: BLE001
        log_error("Dashboard map error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)
