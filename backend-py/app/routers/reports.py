"""
reports.py — ports reports.routes.js exactly (BA-03). Manager-only reporting
endpoints.

GET /attendance        — per-day attendance rows, exportable
GET /dealer-visits     — per-visit rows, exportable
GET /distance-duration — per-employee rollup over the range
GET /exceptions        — read-only mirror of GET /api/visits/exceptions
GET /absences          — read-only mirror of the day_absent manager
                          notifications absenceCheck.js creates

All accept ?from=YYYY-MM-DD&to=YYYY-MM-DD&employee_id=&format=csv|json
(format defaults to json); most also accept employee_ids (CSV of ints,
takes precedence over employee_id) and/or dealer_id.

Response-shape note (see NOTES below): sendReport()'s JSON branch in the
Node source returns the *raw* `pg` driver rows straight from res.json(),
NOT the app's usual hand-normalized shape — so this router deliberately
does NOT run these rows through the shared json_shape.serialize_row()
(which would coerce NUMERIC columns to floats). Instead `_report_row_for_json`
below mirrors node-postgres's actual wire-to-JS type mapping field-for-field:
- TIMESTAMPTZ -> ISO string with millisecond precision + 'Z' (same as
  everywhere else in the app, since res.json() calls Date#toJSON()).
- DATE -> plain 'YYYY-MM-DD' string (pool.js's custom OID 1082 parser
  returns the raw text already, so no Date object is ever involved).
- NUMERIC/DECIMAL (i.e. any column explicitly cast with `::numeric`, e.g.
  ROUND(x::numeric, 2)) -> a STRING, not a number — node-postgres's default
  type parser for OID 1700 returns the driver's raw text representation
  verbatim (so trailing zeros from ROUND(...,2) are preserved, e.g. "12.30"
  not 12.3), and reports.routes.js never re-parses these before sending.
  This is genuinely different from every other router in this codebase,
  which either doesn't select ::numeric columns or explicitly parseFloat's
  them before responding.
- BIGINT (e.g. a bare `COUNT(*)` subquery, as in the attendance report's
  `visits_count`) -> also a STRING for the same node-postgres-default-parser
  reason (OID 20); ported here as an explicit `force_string_keys` override
  per query, since asyncpg (unlike pg) returns int8 as a native Python int
  with no way to distinguish it from int4 after the fact.
- Everything else (INTEGER, BOOLEAN, TEXT, plain DOUBLE PRECISION) maps to
  the equivalent native JSON type with no adjustment needed.

The CSV branch is a genuinely different code path in the Node source (not
built from the JSON-shaped rows): `toCsv()` stringifies the *raw* pg rows
directly via JS `String(val)`, which for a TIMESTAMPTZ column means
`String(dateObject)` invokes `Date.prototype.toString()` (the verbose local-
timezone format, e.g. "Wed Aug 27 2026 05:30:00 GMT+0000 (Coordinated
Universal Time)"), NOT `toISOString()`/`toJSON()`. This is unrelated to (and
looks unintentional next to) the ISO-formatted timestamps the JSON branch of
the very same endpoint returns, but it's what the Node code actually does,
so `_js_date_tostring` below reproduces it rather than "fixing" it to ISO.
It assumes the process runs with UTC as its local timezone, which is true of
this app's actual deployment target (Render) — see the identical assumption
already called out in dashboard.routes.js's toLocaleTimeString comment.
"""
import re
from datetime import date, datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, Depends, Request
from starlette.responses import JSONResponse, Response

from app.core.logging_config import log_error
from app.core.security import Employee, require_manager
from app.db import pool
from app.utils.business_day import business_date_expr
from app.utils.json_shape import iso_z
from app.utils.pg_params import parse_date_string

router = APIRouter(dependencies=[Depends(require_manager)])

# Raw primary/foreign-key fields kept on report rows for internal use (the
# exceptions "Mark reviewed" action needs `id`) but excluded from the CSV
# itself — mirrors ID_LIKE_KEYS in web/src/utils/reports.jsx, which does the
# same exclusion for the on-screen table columns.
ID_LIKE_KEYS = ["id", "employee_id", "dealer_id", "attendance_id", "visit_id"]

# Reports that LIMIT their query to this many rows — if a result comes back
# at exactly this size, it's likely (though not certain) that more rows
# exist beyond it, so the UI can warn rather than silently showing/exporting
# a partial result with no indication anything was cut off.
ROW_CAP = 2000

# Strict YYYY-MM-DD check — Date.parse() accepts many non-ISO formats
# (including some whose string order doesn't match calendar order), and an
# outright malformed value like "abc" reaches Postgres's own date cast and
# surfaces as an uncaught 500 instead of a clean 400.
DATE_ONLY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _is_valid_date_string(value) -> bool:
    if not isinstance(value, str) or not DATE_ONLY_RE.match(value):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        return False
    return True


_JS_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
_JS_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _js_date_tostring(value: datetime) -> str:
    """Mirrors JS `String(dateObject)` (Date.prototype.toString()), which is
    what the hand-rolled CSV writer in reports.routes.js actually invokes on
    a raw pg-driver TIMESTAMPTZ value — see the module docstring above.

    Renders in the SERVER PROCESS'S OS-configured local timezone, not UTC —
    verified live: this dev machine's Node process (Windows, IST) produced
    "Thu Aug 27 2026 15:31:52 GMT+0530 (India Standard Time)" for the same
    instant a hardcoded-UTC version of this function rendered as
    "...GMT+0000 (Coordinated Universal Time)" — a real mismatch, not a
    theoretical one. `datetime.astimezone()` with no argument converts to
    the Python process's own local system timezone the same way, so this
    tracks whatever OS timezone the deployment actually runs under (UTC on
    Render, IST here) automatically, matching Node's behavior rather than
    assuming a single fixed zone.
    """
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    local = value.astimezone()
    weekday = _JS_WEEKDAYS[local.isoweekday() - 1]
    month = _JS_MONTHS[local.month - 1]
    offset = local.strftime("%z")  # e.g. "+0530"
    tzname = local.tzname() or ""
    return (
        f"{weekday} {month} {local.day:02d} {local.year} "
        f"{local.hour:02d}:{local.minute:02d}:{local.second:02d} "
        f"GMT{offset} ({tzname})"
    )


def _report_row_for_json(record, force_string_keys=()) -> dict:
    row = {}
    for k, v in dict(record).items():
        if k in force_string_keys and v is not None:
            row[k] = str(v)
        elif isinstance(v, datetime):
            row[k] = iso_z(v)
        elif isinstance(v, date):
            row[k] = v.isoformat()
        elif isinstance(v, Decimal):
            row[k] = str(v)
        else:
            row[k] = v
    return row


def _report_row_for_csv(record) -> dict:
    row = {}
    for k, v in dict(record).items():
        if isinstance(v, datetime):
            row[k] = _js_date_tostring(v)
        elif isinstance(v, date):
            row[k] = v.isoformat()
        elif isinstance(v, Decimal):
            row[k] = str(v)
        elif isinstance(v, bool):
            row[k] = "true" if v else "false"
        else:
            row[k] = v
    return row


def _csv_escape(val) -> str:
    if val is None:
        return ""
    s = str(val)
    if '"' in s or "," in s or "\n" in s:
        s = '"' + s.replace('"', '""') + '"'
    return s


def _to_csv(rows: list, exclude_keys) -> str:
    if not rows:
        return ""
    headers = [h for h in rows[0].keys() if h not in exclude_keys]
    lines = [",".join(headers)]
    for row in rows:
        lines.append(",".join(_csv_escape(row.get(h)) for h in headers))
    return "\n".join(lines)


def _send_report(rows, format_, filename, force_string_keys=()):
    truncated = len(rows) >= ROW_CAP
    if format_ == "csv":
        csv_rows = [_report_row_for_csv(r) for r in rows]
        body = _to_csv(csv_rows, ID_LIKE_KEYS)
        # The JSON branch has a `truncated` body field; a raw CSV download has
        # no body to attach one to, so this header is the equivalent signal
        # that the export was capped at ROW_CAP rows and isn't the complete
        # result.
        return Response(
            content=body,
            headers={
                "Content-Type": "text/csv",
                "Content-Disposition": f'attachment; filename="{filename}"',
                "X-Report-Truncated": "true" if truncated else "false",
            },
        )
    json_rows = [_report_row_for_json(r, force_string_keys) for r in rows]
    return {"rows": json_rows, "count": len(rows), "truncated": truncated}


def _build_date_employee_filter(query: dict, params: list, conditions: list, date_column: str):
    """Returns an error message string if employee_id/employee_ids was given
    but invalid, otherwise None. `employee_ids` (comma-separated, from the
    report filter's multi-select) takes precedence over the older singular
    `employee_id` (still used as-is by RepFullReport.jsx) when both are
    present."""
    employee_ids = query.get("employee_ids")
    employee_id = query.get("employee_id")
    from_ = query.get("from")
    to = query.get("to")

    if employee_ids:
        ids = []
        for part in employee_ids.split(","):
            part = part.strip()
            try:
                ids.append(int(part))
            except ValueError:
                continue
        if len(ids) == 0:
            return "Invalid employee_ids"
        params.append(ids)
        conditions.append(f"a.employee_id = ANY(${len(params)}::int[])")
    elif employee_id:
        try:
            employee_id_val = int(employee_id)
        except ValueError:
            return "Invalid employee_id"
        params.append(employee_id_val)
        conditions.append(f"a.employee_id = ${len(params)}")

    # Filtered against the app's business-day boundary (5am IST rollover, see
    # business_day.py), not the raw UTC calendar date — otherwise a manager
    # filtering by a given date got results that don't match what the app
    # itself (and the rep's own device) considers that business day for any
    # record near the boundary.
    if from_:
        if not _is_valid_date_string(from_):
            return "Invalid from date (expected YYYY-MM-DD)"
        params.append(parse_date_string(from_))
        conditions.append(f"{business_date_expr(date_column)} >= ${len(params)}::date")
    if to:
        if not _is_valid_date_string(to):
            return "Invalid to date (expected YYYY-MM-DD)"
        params.append(parse_date_string(to))
        conditions.append(f"{business_date_expr(date_column)} <= ${len(params)}::date")
    return None


def _push_dealer_id_filter(dealer_id_param, params: list, conditions: list, column: str):
    """Returns an error message string if dealer_id was given but isn't a
    valid integer, otherwise None."""
    if not dealer_id_param:
        return None
    try:
        dealer_id = int(dealer_id_param)
    except ValueError:
        return "Invalid dealer_id"
    params.append(dealer_id)
    conditions.append(f"{column} = ${len(params)}")
    return None


@router.get("/attendance")
async def attendance_report(request: Request, employee: Employee = Depends(require_manager)):
    q = request.query_params
    format_ = q.get("format")
    conditions: list = []
    params: list = []
    filter_error = _build_date_employee_filter(q, params, conditions, "a.login_time")
    if filter_error:
        return JSONResponse({"error": filter_error}, status_code=400)
    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    try:
        rows = await pool.fetch(
            f"""
            SELECT e.name AS employee_name, e.region,
                   a.login_time, a.logout_time, a.work_mode,
                   a.total_duration_minutes, ROUND(a.total_distance_km::numeric, 2) AS total_distance_km,
                   (SELECT COUNT(*) FROM client_visits cv WHERE cv.attendance_id = a.id) AS visits_count
            FROM attendance a
            JOIN employees e ON e.id = a.employee_id
            {where_clause}
            ORDER BY a.login_time DESC
            LIMIT 2000
            """,
            *params,
        )
        return _send_report(rows, format_, "attendance-report.csv", force_string_keys=("visits_count",))
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/reports/attendance error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.get("/dealer-visits")
async def dealer_visits_report(request: Request, employee: Employee = Depends(require_manager)):
    q = request.query_params
    format_ = q.get("format")
    dealer_id = q.get("dealer_id")
    conditions: list = []
    params: list = []
    filter_error = _build_date_employee_filter(q, params, conditions, "cv.login_time") \
        or _push_dealer_id_filter(dealer_id, params, conditions, "cv.dealer_id")
    if filter_error:
        return JSONResponse({"error": filter_error}, status_code=400)
    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    try:
        rows = await pool.fetch(
            f"""
            SELECT e.name AS employee_name, d.name AS dealer_name, d.address AS dealer_address,
                   cv.login_time, cv.logout_time, cv.visit_duration_minutes,
                   ROUND(cv.distance_from_previous_km::numeric, 2) AS distance_from_previous_km, cv.out_of_radius,
                   cv.login_inside_radius,
                   (cv.login_inside_radius = false AND cv.out_of_radius = true) AS needs_verification
            FROM client_visits cv
            JOIN attendance a ON a.id = cv.attendance_id
            JOIN employees e ON e.id = a.employee_id
            JOIN dealers d    ON d.id = cv.dealer_id
            {where_clause}
            ORDER BY cv.login_time DESC
            LIMIT 2000
            """,
            *params,
        )
        return _send_report(rows, format_, "dealer-visits-report.csv")
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/reports/dealer-visits error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.get("/distance-duration")
async def distance_duration_report(request: Request, employee: Employee = Depends(require_manager)):
    q = request.query_params
    format_ = q.get("format")
    conditions: list = []
    params: list = []
    filter_error = _build_date_employee_filter(q, params, conditions, "a.login_time")
    if filter_error:
        return JSONResponse({"error": filter_error}, status_code=400)
    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    try:
        result_rows = await pool.fetch(
            f"""
            SELECT e.id AS employee_id, e.name AS employee_name, e.region,
                   COUNT(DISTINCT a.id)                       AS days_worked,
                   COALESCE(SUM(a.total_distance_km), 0)      AS total_distance_km,
                   COALESCE(SUM(a.total_duration_minutes), 0) AS total_duration_minutes,
                   COALESCE(COUNT(cv.id), 0)                  AS total_visits,
                   COALESCE(AVG(cv.visit_duration_minutes), 0) AS avg_visit_duration_minutes
            FROM attendance a
            JOIN employees e ON e.id = a.employee_id
            LEFT JOIN client_visits cv ON cv.attendance_id = a.id
            {where_clause}
            GROUP BY e.id, e.name, e.region
            ORDER BY e.name
            """,
            *params,
        )

        rows = [
            {
                "employee_id": r["employee_id"],
                "employee_name": r["employee_name"],
                "region": r["region"],
                "days_worked": int(r["days_worked"]),
                "total_distance_km": f"{float(r['total_distance_km'] or 0):.2f}",
                "total_duration_minutes": int(r["total_duration_minutes"]),
                "total_visits": int(r["total_visits"]),
                "avg_visit_duration_minutes": f"{float(r['avg_visit_duration_minutes'] or 0):.1f}",
            }
            for r in result_rows
        ]

        return _send_report(rows, format_, "distance-duration-report.csv")
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/reports/distance-duration error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


# GET /exceptions — read-only mirror of GET /api/visits/exceptions, shaped to
# fit ReportsPage.jsx's generic fetch/CSV-export flow. Marking an exception
# reviewed is a write action and stays on PATCH /api/visits/exceptions/:id.
@router.get("/exceptions")
async def exceptions_report(request: Request, employee: Employee = Depends(require_manager)):
    q = request.query_params
    format_ = q.get("format")
    employee_id = q.get("employee_id")
    employee_ids = q.get("employee_ids")
    dealer_id = q.get("dealer_id")
    conditions: list = []
    params: list = []

    # _build_date_employee_filter assumes an `a.employee_id` alias for the
    # employee filter, but this query has no attendance join — pass only
    # from/to through it and apply employee_id/dealer_id filters against `el`
    # directly below.
    date_filter_error = _build_date_employee_filter(
        {"from": q.get("from"), "to": q.get("to")}, params, conditions, "el.created_at"
    )
    if date_filter_error:
        return JSONResponse({"error": date_filter_error}, status_code=400)
    dealer_filter_error = _push_dealer_id_filter(dealer_id, params, conditions, "el.dealer_id")
    if dealer_filter_error:
        return JSONResponse({"error": dealer_filter_error}, status_code=400)

    # This report is for login/logout radius exceptions a rep had to type a
    # written reason for — 'interrupted' rows are a different thing
    # entirely: an automatic mid-visit "left the dealer premises" flag from
    # the Random Location Verification poll, with no rep-provided reason and
    # nothing for a manager to review here. They're excluded unconditionally
    # rather than behind a filter toggle.
    conditions.append("el.event_type <> 'interrupted'")

    if employee_ids:
        ids = []
        for part in employee_ids.split(","):
            part = part.strip()
            try:
                ids.append(int(part))
            except ValueError:
                continue
        if len(ids) == 0:
            return JSONResponse({"error": "Invalid employee_ids"}, status_code=400)
        params.append(ids)
        conditions.append(f"el.employee_id = ANY(${len(params)}::int[])")
    elif employee_id:
        try:
            employee_id_val = int(employee_id)
        except ValueError:
            return JSONResponse({"error": "Invalid employee_id"}, status_code=400)
        params.append(employee_id_val)
        conditions.append(f"el.employee_id = ${len(params)}")

    where_clause = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    try:
        rows = await pool.fetch(
            f"""
            SELECT el.id, e.name AS employee_name, d.name AS dealer_name, el.event_type,
                   el.latitude, el.longitude, ROUND(el.distance_meters::numeric, 1) AS distance_meters,
                   ROUND(el.gps_accuracy_m::numeric, 1) AS gps_accuracy_m, el.reason,
                   el.matched_login, el.manager_reviewed, el.created_at,
                   EXISTS (
                     SELECT 1 FROM exception_log el2
                     WHERE el2.visit_id = el.visit_id
                       AND el2.event_type <> el.event_type
                       AND el2.event_type IN ('login', 'logout')
                   ) AS needs_verification
            FROM exception_log el
            JOIN employees e ON e.id = el.employee_id
            JOIN dealers d    ON d.id = el.dealer_id
            {where_clause}
            ORDER BY el.created_at DESC
            LIMIT 2000
            """,
            *params,
        )
        return _send_report(rows, format_, "exceptions-report.csv")
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/reports/exceptions error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


# GET /absences — read-only mirror of the day_absent manager notifications
# absenceCheck.js creates, shaped to fit ReportsPage.jsx's generic
# fetch/CSV-export flow, sorted by the actual missed business date rather
# than notification-created-at order (the two usually match, but a sweep
# catching up on a backlog after a spin-down can create the notification a
# day or more after the date it's actually about).
@router.get("/absences")
async def absences_report(request: Request, employee: Employee = Depends(require_manager)):
    q = request.query_params
    format_ = q.get("format")
    employee_id = q.get("employee_id")
    employee_ids = q.get("employee_ids")
    conditions: list = ["n.type = 'day_absent'"]
    params: list = []

    # _build_date_employee_filter assumes an `a.employee_id` alias for the
    # employee filter, but this query has no attendance join — pass only
    # from/to through it (against created_at; close enough to the real
    # absence date for a date-RANGE filter even in the rare backlog-catch-up
    # case) and apply employee_id/employee_ids against `n` directly below,
    # same as the exceptions report's identical situation.
    date_filter_error = _build_date_employee_filter(
        {"from": q.get("from"), "to": q.get("to")}, params, conditions, "n.created_at"
    )
    if date_filter_error:
        return JSONResponse({"error": date_filter_error}, status_code=400)

    if employee_ids:
        ids = []
        for part in employee_ids.split(","):
            part = part.strip()
            try:
                ids.append(int(part))
            except ValueError:
                continue
        if len(ids) == 0:
            return JSONResponse({"error": "Invalid employee_ids"}, status_code=400)
        params.append(ids)
        conditions.append(f"n.employee_id = ANY(${len(params)}::int[])")
    elif employee_id:
        try:
            employee_id_val = int(employee_id)
        except ValueError:
            return JSONResponse({"error": "Invalid employee_id"}, status_code=400)
        params.append(employee_id_val)
        conditions.append(f"n.employee_id = ${len(params)}")

    where_clause = f"WHERE {' AND '.join(conditions)}"

    try:
        rows = await pool.fetch(
            f"""
            SELECT n.id, e.name AS employee_name, e.region,
                   {business_date_expr('n.created_at')} AS absence_date,
                   (n.read_at IS NOT NULL) AS reviewed
            FROM manager_notifications n
            JOIN employees e ON e.id = n.employee_id
            {where_clause}
            ORDER BY absence_date DESC, e.name
            LIMIT 2000
            """,
            *params,
        )
        return _send_report(rows, format_, "absences-report.csv")
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/reports/absences error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)
