"""recordings.py — manager-facing views over call_recording (Meeting Recorder
data) for the web dashboard's Recordings tab: recordings grouped by
representative, and recordings grouped by dealer.

Manager-only (router-wide require_manager, same pattern as reports.py) —
this surfaces every rep's recorded conversations across the whole team,
which is squarely manager-only data, unlike the mobile app's own
meeting_recorder.py routes (unauthenticated by necessity, but scoped to
one rep's own owner_id at a time).

Uses this app's normal asyncpg pool (app/db/pool.py), NOT meeting_recorder
module's separate psycopg2 pool — both now point at the same database (see
meeting_recorder.py's own module docstring), so there's no need to reach
into that module at all; this is a completely ordinary /api/* router.

owner_id on call_recording is TEXT (the mobile app sends the rep's employee
id as a plain string — see mobile/src/screens/MeetingRecordScreen.js) but
isn't guaranteed numeric for every historical row, so every query filters to
`owner_id ~ '^[0-9]+$'` before casting, rather than letting a stray
non-numeric value 500 the whole request.
"""
import re

from fastapi import APIRouter, HTTPException, Request, Depends
from starlette.responses import JSONResponse

from app.core.logging_config import log_error
from app.core.security import Employee, require_manager
from app.db import pool
from app.utils.json_shape import serialize_rows
from app.utils.pg_params import parse_date_string

router = APIRouter(dependencies=[Depends(require_manager)])

DATE_ONLY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _escape_like(value: str) -> str:
    """Escapes LIKE metacharacters so a literal '%'/'_' in a search term is
    matched literally instead of acting as a wildcard — same approach as
    dealers.py's own search."""
    return value.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _parse_int_list(raw: str | None) -> list[int] | None:
    if not raw:
        return None
    try:
        ids = [int(x) for x in raw.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="ids must be a comma-separated list of integers")
    return ids or None


def _add_date_range(date_from: str | None, date_to: str | None, params: list, conditions: list, date_column: str = "cr.created_at"):
    """Validates and appends from/to date filters. asyncpg (unlike node-pg)
    requires the bound parameter to already be a Python `date` object
    matching the `::date` cast's inferred type — passing the raw query-string
    (a plain str) raises `DataError("... 'str' object has no attribute
    'toordinal'")` no matter where the `::date` cast appears in the SQL text.
    See app/utils/pg_params.py's own docstring — this bit the very first
    version of this router (worked fine locally by luck, failed live)."""
    if date_from:
        if not DATE_ONLY_RE.match(date_from):
            raise HTTPException(status_code=400, detail="Invalid from date (expected YYYY-MM-DD)")
        params.append(parse_date_string(date_from))
        conditions.append(f"{date_column} >= ${len(params)}::date")
    if date_to:
        if not DATE_ONLY_RE.match(date_to):
            raise HTTPException(status_code=400, detail="Invalid to date (expected YYYY-MM-DD)")
        params.append(parse_date_string(date_to))
        conditions.append(f"{date_column} < (${len(params)}::date + interval '1 day')")


RECORDING_FIELDS = """
    cr.session_id AS id, cr.recording_name, cr.transcript_text, cr.summary,
    cr.summary_status, cr.audio_file_id, cr.duration, cr.created_at,
    cr.processing_status
"""


@router.get("/representatives")
async def list_representatives(request: Request, employee: Employee = Depends(require_manager)):
    """Reps who have at least one recording in the given date range —
    listing surface for the Representatives page, with a recording count
    per rep."""
    search = request.query_params.get("search")
    date_from = request.query_params.get("from")
    date_to = request.query_params.get("to")

    conditions = ["cr.owner_id ~ '^[0-9]+$'"]
    params = []

    _add_date_range(date_from, date_to, params, conditions)
    if search and search.strip():
        params.append(f"%{_escape_like(search)}%")
        conditions.append(f"e.name ILIKE ${len(params)} ESCAPE '\\'")

    where_clause = " AND ".join(conditions)

    try:
        rows = await pool.fetch(
            f"""
            SELECT e.id, e.name, e.region, COUNT(cr.id) AS recording_count,
                   MAX(cr.created_at) AS last_recording_at
            FROM employees e
            JOIN call_recording cr ON cr.owner_id::integer = e.id
            WHERE {where_clause}
            GROUP BY e.id, e.name, e.region
            ORDER BY e.name
            """,
            *params,
        )
        return {"representatives": serialize_rows(rows)}
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/recordings/representatives error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.get("/representatives/{employee_id}")
async def get_representative_recordings(employee_id: int, request: Request, employee: Employee = Depends(require_manager)):
    """One rep's recordings, each annotated with which dealer (if any) it
    was recorded at, plus the distinct dealer list for that rep (to
    populate the dealer filter on this page)."""
    search = request.query_params.get("search")
    date_from = request.query_params.get("from")
    date_to = request.query_params.get("to")
    dealer_ids = _parse_int_list(request.query_params.get("dealer_ids"))

    rep = await pool.fetchrow("SELECT id, name, region FROM employees WHERE id = $1", employee_id)
    if rep is None:
        raise HTTPException(status_code=404, detail="Representative not found")

    conditions = ["cr.owner_id ~ '^[0-9]+$'", "cr.owner_id::integer = $1"]
    params = [employee_id]

    _add_date_range(date_from, date_to, params, conditions)
    if dealer_ids:
        params.append(dealer_ids)
        conditions.append(f"cr.dealer_id = ANY(${len(params)}::int[])")
    if search and search.strip():
        params.append(f"%{_escape_like(search)}%")
        conditions.append(f"(cr.recording_name ILIKE ${len(params)} ESCAPE '\\' OR cr.transcript_text ILIKE ${len(params)} ESCAPE '\\')")

    where_clause = " AND ".join(conditions)

    try:
        rows = await pool.fetch(
            f"""
            SELECT {RECORDING_FIELDS}, cr.dealer_id, d.name AS dealer_name, d.address AS dealer_address
            FROM call_recording cr
            LEFT JOIN dealers d ON d.id = cr.dealer_id
            WHERE {where_clause}
            ORDER BY cr.created_at DESC
            """,
            *params,
        )
        dealer_rows = await pool.fetch(
            """
            SELECT DISTINCT d.id, d.name
            FROM call_recording cr
            JOIN dealers d ON d.id = cr.dealer_id
            WHERE cr.owner_id ~ '^[0-9]+$' AND cr.owner_id::integer = $1
            ORDER BY d.name
            """,
            employee_id,
        )
        return {
            "representative": serialize_rows([rep])[0],
            "recordings": serialize_rows(rows),
            "dealers": serialize_rows(dealer_rows),
        }
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/recordings/representatives/{id} error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.get("/dealers")
async def list_recorded_dealers(request: Request, employee: Employee = Depends(require_manager)):
    """Dealers with at least one recording in the given date range — listing
    surface for the Dealers page, with a recording count per dealer."""
    search = request.query_params.get("search")
    date_from = request.query_params.get("from")
    date_to = request.query_params.get("to")

    conditions = ["TRUE"]
    params = []

    _add_date_range(date_from, date_to, params, conditions)
    if search and search.strip():
        params.append(f"%{_escape_like(search)}%")
        conditions.append(f"d.name ILIKE ${len(params)} ESCAPE '\\'")

    where_clause = " AND ".join(conditions)

    try:
        rows = await pool.fetch(
            f"""
            SELECT d.id, d.name, d.address, COUNT(cr.id) AS recording_count,
                   MAX(cr.created_at) AS last_recording_at
            FROM dealers d
            JOIN call_recording cr ON cr.dealer_id = d.id
            WHERE {where_clause}
            GROUP BY d.id, d.name, d.address
            ORDER BY d.name
            """,
            *params,
        )
        return {"dealers": serialize_rows(rows)}
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/recordings/dealers error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.get("/dealers/{dealer_id}")
async def get_dealer_recordings(dealer_id: int, request: Request, employee: Employee = Depends(require_manager)):
    """One dealer's recordings, each annotated with which rep made it, plus
    the distinct rep list for that dealer (to populate the rep filter on
    this page)."""
    search = request.query_params.get("search")
    date_from = request.query_params.get("from")
    date_to = request.query_params.get("to")
    employee_ids = _parse_int_list(request.query_params.get("employee_ids"))

    dealer = await pool.fetchrow("SELECT id, name, address FROM dealers WHERE id = $1", dealer_id)
    if dealer is None:
        raise HTTPException(status_code=404, detail="Dealer not found")

    conditions = ["cr.dealer_id = $1"]
    params = [dealer_id]

    _add_date_range(date_from, date_to, params, conditions)
    if employee_ids:
        params.append(employee_ids)
        conditions.append(f"cr.owner_id ~ '^[0-9]+$' AND cr.owner_id::integer = ANY(${len(params)}::int[])")
    if search and search.strip():
        params.append(f"%{_escape_like(search)}%")
        conditions.append(f"(cr.recording_name ILIKE ${len(params)} ESCAPE '\\' OR cr.transcript_text ILIKE ${len(params)} ESCAPE '\\')")

    where_clause = " AND ".join(conditions)

    try:
        rows = await pool.fetch(
            f"""
            SELECT {RECORDING_FIELDS}, cr.owner_id, e.name AS employee_name
            FROM call_recording cr
            LEFT JOIN employees e ON cr.owner_id ~ '^[0-9]+$' AND e.id = cr.owner_id::integer
            WHERE {where_clause}
            ORDER BY cr.created_at DESC
            """,
            *params,
        )
        rep_rows = await pool.fetch(
            """
            SELECT DISTINCT e.id, e.name
            FROM call_recording cr
            JOIN employees e ON cr.owner_id ~ '^[0-9]+$' AND e.id = cr.owner_id::integer
            WHERE cr.dealer_id = $1
            ORDER BY e.name
            """,
            dealer_id,
        )
        return {
            "dealer": serialize_rows([dealer])[0],
            "recordings": serialize_rows(rows),
            "representatives": serialize_rows(rep_rows),
        }
    except Exception as err:  # noqa: BLE001
        log_error("GET /api/recordings/dealers/{id} error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)
