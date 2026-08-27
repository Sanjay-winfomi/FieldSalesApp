"""
navigation.py — ports navigation.routes.js exactly: Google Routes API
(Compute Routes Pro)-backed "Tap Navigate" flow, plus the resulting
navigation lifecycle/history.

POST  /api/navigation/compute          — any authenticated employee: fetch a
                                           route to a dealer, persists a
                                           dealer_navigations row and advances
                                           the assignment's status
POST  /api/navigation/distance-preview — any authenticated employee: a
                                           read-only driving distance/duration
                                           between two points, no DB writes at
                                           all
PATCH /api/navigation/{id}/status      — any authenticated employee: update
                                           the navigation's lifecycle status
GET   /api/navigation/history          — manager-only: paginated navigation history
GET   /api/navigation/summary/today    — any authenticated employee: today's
                                           Daily Travel Summary

Never calls Route Optimization / Fleet Routing — always a single
origin -> destination pair, matching the fixed assignment sequence.
"""
import math
import re
from datetime import datetime

from fastapi import APIRouter, Depends, Request
from starlette.responses import JSONResponse

from app.core.logging_config import log_error
from app.core.security import Employee, get_current_employee, require_manager
from app.db import pool
from app.services import idempotency
from app.services.google_routes import RoutesApiError, compute_route
from app.utils.business_day import business_date_expr
from app.utils.json_shape import serialize_row, serialize_rows

router = APIRouter(dependencies=[Depends(get_current_employee)])

STATUSES = ["navigating", "arrived", "completed", "cancelled"]


_PARSE_INT_RE = re.compile(r"^\s*[-+]?\d+")


def _parse_int_loose(value):
    """Mirrors JS parseInt(value): leading numeric prefix, else NaN (-> None)."""
    if value is None:
        return None
    m = _PARSE_INT_RE.match(str(value))
    return int(m.group(0)) if m else None


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


# POST /api/navigation/compute  { dealer_id, assignment_id?, origin_lat, origin_lng }
@router.post("/compute")
async def compute_navigation(request: Request, employee: Employee = Depends(get_current_employee)):
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

    origin_lat = _parse_coord(body.get("origin_lat"), -90, 90)
    origin_lng = _parse_coord(body.get("origin_lng"), -180, 180)
    if origin_lat is None or origin_lng is None:
        return JSONResponse({"error": "origin_lat and origin_lng must be valid numbers"}, status_code=400)

    employee_id = employee.id
    idempotency_key = request.headers.get("idempotency-key")

    try:
        # Without this, a fast double-tap on "Navigate" (or a retried request
        # that actually reached the server but whose response the client
        # missed) could insert a second dealer_navigations row and fire a
        # second real Google Routes API charge for what the rep experiences as
        # one tap — the same class of duplicate-write risk every other
        # mutating route in this codebase already guards against.
        cached = await idempotency.get_idempotent_response(idempotency_key, employee_id, "navigation/compute")
        if cached:
            return JSONResponse(cached["response_body"], status_code=cached["response_status"])

        dealer = await pool.fetchrow(
            "SELECT id, name, latitude, longitude FROM dealers WHERE id = $1", dealer_id
        )
        if dealer is None:
            return JSONResponse({"error": "Dealer not found"}, status_code=404)
        if dealer["latitude"] is None or dealer["longitude"] is None:
            return JSONResponse({"error": "dealer_missing_coordinates"}, status_code=422)

        if assignment_id is not None:
            # Must also match dealer_id — without this, a navigation computed
            # for dealer A could be tied to an assignment actually for dealer
            # B, advancing dealer B's assignment status (via
            # markAssignmentVisited) and misattributing dealer-A
            # distance/duration to dealer B in the Daily Travel Summary.
            assignment_row = await pool.fetchrow(
                "SELECT id FROM dealer_assignments WHERE id = $1 AND employee_id = $2 AND dealer_id = $3",
                assignment_id, employee_id, dealer_id,
            )
            if assignment_row is None:
                return JSONResponse({"error": "Assignment not found"}, status_code=404)

        try:
            route = await compute_route(origin_lat, origin_lng, float(dealer["latitude"]), float(dealer["longitude"]))
        except RoutesApiError as err:
            log_error("Routes API compute error", error=str(err), dealer_id=dealer_id, employee_id=employee_id)
            return JSONResponse(
                {"error": "route_computation_failed", "message": "Request timed out — Retry"}, status_code=502
            )

        eta_seconds = route.duration_in_traffic_seconds if route.duration_in_traffic_seconds is not None else (
            route.duration_seconds if route.duration_seconds is not None else 0
        )

        nav_row = await pool.fetchrow(
            """
            INSERT INTO dealer_navigations
                (assignment_id, employee_id, dealer_id, status, origin_latitude, origin_longitude,
                 distance_meters, duration_seconds, duration_in_traffic_seconds, expected_arrival_time, encoded_polyline)
            VALUES ($1, $2, $3, 'navigating', $4, $5, $6, $7, $8, NOW() + make_interval(secs => $9::int), $10)
            RETURNING id, status, distance_meters, duration_seconds, duration_in_traffic_seconds,
                      expected_arrival_time, encoded_polyline, started_at
            """,
            assignment_id, employee_id, dealer_id, origin_lat, origin_lng,
            route.distance_meters, route.duration_seconds, route.duration_in_traffic_seconds,
            eta_seconds, route.encoded_polyline,
        )

        if assignment_id is not None:
            # Same rank/status guard as PATCH /:id/status below — without it, a
            # rep re-tapping "Navigate" for an assignment already 'completed'
            # (or manager-'cancelled') would silently force it back to
            # 'navigating', making the Daily Travel Summary miscount a visited
            # dealer as pending, or resurrecting a cancelled assignment.
            await pool.execute(
                """
                UPDATE dealer_assignments
                SET status = 'navigating', updated_at = NOW()
                WHERE id = $1
                  AND status != 'cancelled'
                  AND status != 'completed'
                  AND status != 'arrived'
                """,
                assignment_id,
            )

        response_body = {"navigation": serialize_row(nav_row)}
        await idempotency.save_idempotent_response(idempotency_key, employee_id, "navigation/compute", 201, response_body)
        return JSONResponse(response_body, status_code=201)
    except Exception as err:  # noqa: BLE001
        log_error("POST /api/navigation/compute error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


# POST /api/navigation/distance-preview  { origin_lat, origin_lng, dest_lat, dest_lng }
# Read-only: a real Google-Maps driving distance/duration between two
# points, with NOTHING persisted — no dealer_navigations row, no
# assignment status change. Distinct from /compute (which IS "the rep
# tapped Navigate" and behaves accordingly) — this is just "show me a real
# number," usable from a manager's Visit Plan builder (dealer-to-dealer) or
# a rep's assigned-dealer card (rep's current GPS-to-dealer) without either
# implying a navigation attempt actually started.
@router.post("/distance-preview")
async def distance_preview(request: Request, employee: Employee = Depends(get_current_employee)):
    body = await request.json()
    origin_lat = _parse_coord(body.get("origin_lat"), -90, 90)
    origin_lng = _parse_coord(body.get("origin_lng"), -180, 180)
    dest_lat = _parse_coord(body.get("dest_lat"), -90, 90)
    dest_lng = _parse_coord(body.get("dest_lng"), -180, 180)
    if origin_lat is None or origin_lng is None or dest_lat is None or dest_lng is None:
        return JSONResponse(
            {"error": "origin_lat, origin_lng, dest_lat, and dest_lng must be valid numbers"}, status_code=400
        )

    try:
        route = await compute_route(origin_lat, origin_lng, dest_lat, dest_lng)
        return {
            "distanceMeters": route.distance_meters,
            "durationSeconds": route.duration_seconds,
            "durationInTrafficSeconds": route.duration_in_traffic_seconds,
        }
    except RoutesApiError as err:
        log_error("POST /api/navigation/distance-preview error", error=str(err))
        return JSONResponse(
            {"error": "route_computation_failed", "message": "Request timed out — Retry"}, status_code=502
        )


# PATCH /api/navigation/{id}/status  { status }
@router.patch("/{navigation_id}/status")
async def patch_navigation_status(navigation_id: str, request: Request, employee: Employee = Depends(get_current_employee)):
    id_val = _parse_int_loose(navigation_id)
    if id_val is None:
        return JSONResponse({"error": "Invalid navigation id"}, status_code=400)

    body = await request.json()
    status_val = body.get("status")
    if status_val not in STATUSES:
        return JSONResponse({"error": f"status must be one of: {', '.join(STATUSES)}"}, status_code=400)

    try:
        existing = await pool.fetchrow(
            "SELECT id, employee_id, assignment_id FROM dealer_navigations WHERE id = $1", id_val
        )
        if existing is None:
            return JSONResponse({"error": "Navigation not found"}, status_code=404)
        if existing["employee_id"] != employee.id:
            return JSONResponse({"error": "Not authorized to update this navigation"}, status_code=403)

        is_terminal = status_val in ("completed", "cancelled")
        updated = await pool.fetchrow(
            """
            UPDATE dealer_navigations
            SET status = $1, ended_at = CASE WHEN $2 THEN NOW() ELSE ended_at END
            WHERE id = $3
            RETURNING id, status, ended_at
            """,
            status_val, is_terminal, id_val,
        )

        assignment_id = existing["assignment_id"]
        if assignment_id is not None and status_val != "cancelled":
            # 'arrived'/'completed' map directly; a cancelled navigation
            # attempt doesn't mean the visit itself is cancelled, so the
            # assignment is left as-is rather than mirrored to 'cancelled'.
            # The rank comparison guards against regressing an assignment
            # backward: a rep can have multiple navigation attempts for one
            # assignment (re-tapping Navigate creates a new
            # dealer_navigations row each time), so a late/out-of-order
            # status update from an earlier, abandoned attempt (e.g. a stale
            # 'arrived' landing after the dealer check-in already advanced
            # this assignment to 'completed') must not downgrade it.
            # status != 'cancelled' is its own explicit condition (not
            # folded into the rank CASE) — 'cancelled' would otherwise share
            # rank 0 with 'pending' in the ELSE branch, letting this same
            # late/stale update resurrect an assignment a manager had
            # deliberately cancelled.
            await pool.execute(
                """
                UPDATE dealer_assignments
                SET status = $1, updated_at = NOW()
                WHERE id = $2
                  AND status != 'cancelled'
                  AND (CASE status WHEN 'completed' THEN 3 WHEN 'arrived' THEN 2 WHEN 'navigating' THEN 1 ELSE 0 END)
                    < (CASE $1     WHEN 'completed' THEN 3 WHEN 'arrived' THEN 2 WHEN 'navigating' THEN 1 ELSE 0 END)
                """,
                status_val, assignment_id,
            )

        return {"navigation": serialize_row(updated)}
    except Exception as err:  # noqa: BLE001
        log_error("PATCH /api/navigation/:id/status error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


# GET /api/navigation/history?employee_id=&date=&page=&limit=
@router.get("/history")
async def navigation_history(request: Request, employee: Employee = Depends(require_manager)):
    q = request.query_params

    employee_id = None
    if q.get("employee_id"):
        employee_id = _parse_int_loose(q.get("employee_id"))
        if employee_id is None:
            return JSONResponse({"error": "Invalid employee_id"}, status_code=400)

    date_param = q.get("date")
    date_val = None
    if date_param:
        try:
            # asyncpg binds a `::date`-cast parameter strictly from a native
            # datetime.date, not a string (verified directly against
            # asyncpg — see app/utils/pg_params.py's module docstring for
            # the full explanation); node-pg accepts the raw string and
            # lets Postgres's own cast parse it.
            date_val = datetime.fromisoformat(date_param.replace("Z", "+00:00")).date()
        except ValueError:
            date_val = None

    page = max(_parse_int_loose(q.get("page")) or 1, 1)
    limit = min(max(_parse_int_loose(q.get("limit")) or 20, 1), 100)
    offset = (page - 1) * limit

    try:
        conditions = []
        params: list = []
        if employee_id is not None:
            params.append(employee_id)
            conditions.append(f"nav.employee_id = ${len(params)}")
        if date_val is not None:
            params.append(date_val)
            conditions.append(f"{business_date_expr('nav.started_at')} = ${len(params)}::date")
        where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        total_row = await pool.fetchrow(
            f"SELECT COUNT(*)::int AS total FROM dealer_navigations nav {where_clause}", *params
        )
        total = total_row["total"]

        rows = await pool.fetch(
            f"""
            SELECT nav.id, nav.employee_id, e.name AS employee_name, nav.dealer_id, d.name AS dealer_name,
                   nav.status, nav.distance_meters, nav.duration_seconds, nav.duration_in_traffic_seconds,
                   nav.expected_arrival_time, nav.started_at, nav.ended_at
            FROM dealer_navigations nav
            JOIN employees e ON e.id = nav.employee_id
            JOIN dealers d ON d.id = nav.dealer_id
            {where_clause}
            ORDER BY nav.started_at DESC
            LIMIT ${len(params) + 1} OFFSET ${len(params) + 2}
            """,
            *params, limit, offset,
        )

        return {
            "navigations": serialize_rows(rows),
            "total": total,
            "page": page,
            "pageCount": max(math.ceil(total / limit), 1) if limit else 1,
        }
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/navigation/history error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


# GET /api/navigation/summary/today — Daily Travel Summary, scoped to
# assignment-linked navigations (a manually-navigated, unassigned dealer
# doesn't count toward "assigned" totals).
@router.get("/summary/today")
async def summary_today(employee: Employee = Depends(get_current_employee)):
    employee_id = employee.id

    try:
        assignment_counts = await pool.fetchrow(
            f"""
            SELECT
              COUNT(*) FILTER (WHERE status != 'cancelled')::int AS total_assigned,
              COUNT(*) FILTER (WHERE status = 'completed')::int AS visited,
              COUNT(*) FILTER (WHERE status != 'completed' AND status != 'cancelled')::int AS pending
            FROM dealer_assignments
            WHERE employee_id = $1 AND assignment_date = {business_date_expr('NOW()')}
            """,
            employee_id,
        )

        nav_totals = await pool.fetchrow(
            f"""
            SELECT
              COALESCE(SUM(distance_meters) FILTER (WHERE status = 'completed'), 0)::int AS distance_travelled_m,
              COALESCE(SUM(distance_meters) FILTER (WHERE status != 'completed' AND status != 'cancelled'), 0)::int AS remaining_distance_m,
              COALESCE(SUM(duration_seconds) FILTER (WHERE status = 'completed'), 0)::int AS driving_time_completed_s,
              COALESCE(SUM(duration_in_traffic_seconds) FILTER (WHERE status != 'completed' AND status != 'cancelled'), 0)::int AS estimated_remaining_time_s
            FROM dealer_navigations
            WHERE employee_id = $1 AND assignment_id IS NOT NULL
              AND {business_date_expr('started_at')} = {business_date_expr('NOW()')}
            """,
            employee_id,
        )

        counts = assignment_counts
        totals = nav_totals

        return {
            "total_assigned_dealers": counts["total_assigned"],
            "visited_dealers": counts["visited"],
            "pending_dealers": counts["pending"],
            "total_planned_distance_m": totals["distance_travelled_m"] + totals["remaining_distance_m"],
            "distance_travelled_m": totals["distance_travelled_m"],
            "remaining_distance_m": totals["remaining_distance_m"],
            "total_driving_time_s": totals["driving_time_completed_s"],
            "estimated_remaining_time_s": totals["estimated_remaining_time_s"],
            "completed_visits": counts["visited"],
            "pending_visits": counts["pending"],
        }
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/navigation/summary/today error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)
