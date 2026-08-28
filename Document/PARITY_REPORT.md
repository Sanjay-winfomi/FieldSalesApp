# Parity Report — Node/Express vs Python/FastAPI (FieldTrack)

## What this report covers, and its limits

This environment has no running Postgres instance and no running Node
backend to diff live traffic against — so this is a **structural/static
parity review**, not the live side-by-side request-diffing Phase 3
describes. Every route was ported by reading the actual `.js` source file
(not just INVENTORY.md's summary) and cross-checked line-by-line against
the Python port during this review. What's below is what that review
covers and doesn't; the traffic-diffing pass against a live database is
the real Phase 3 and still needs to happen before cutover — see the
"How to run the live parity pass" section at the end.

## Structural verification performed

- **Route inventory**: `app.main.app.routes` enumerated after import —
  all 55 real `/api/*` endpoints from INVENTORY.md's route table are
  present at the exact same path/method, plus `/health`, `/health/deep`.
  No extra, missing, or misspelled routes.
- **Full app import**: `app.main` imports cleanly with a real dependency
  install (`pip install -r requirements.txt` into a fresh venv) — no
  wiring errors, no missing router exports, no circular imports.
- **Syntax**: every `.py` file under `app/` compiles cleanly
  (`py_compile`).
- **Line-by-line spot review against Node source** (not just the porting
  agents' own self-report) for the highest-risk modules:
  - `attendance.py` / `visits.py` — ported directly by hand, not by
    subagent, given they're the geofencing/GPS-accuracy/transaction-heavy
    core.
  - `dealers.py`, `followup_requests.py`, `assignments.py` — diffed
    against `dealers.routes.js`, `followupRequests.routes.js`,
    `assignments.routes.js` directly; transaction boundaries, advisory
    lock key format (`pg_advisory_xact_lock(hashtext('dealer_assignments:'
    || employee_id || ':' || date))`), and the pending→approved atomic
    claim pattern all match.
  - `reports.py` — diffed against `reports.routes.js`; confirmed the
    subtle node-postgres-driver-default behavior (NUMERIC/`::numeric`
    columns and bare `COUNT(*)` serialize as **strings**, not numbers, in
    the JSON branch) is reproduced correctly: asyncpg returns `NUMERIC` as
    `Decimal` (stringified unconditionally in `_report_row_for_json`), and
    `BIGINT`/`COUNT(*)` is handled via an explicit `force_string_keys`
    override since asyncpg returns int8 as a native Python `int` with no
    way to distinguish it from int4 after the fact.
- **Response-shape parity mechanism**: every router routes raw query
  results through `serialize_row()`/`serialize_rows()` (or, in
  `reports.py`'s case, the report-specific equivalent) so TIMESTAMPTZ
  columns match Node's exact `Date#toJSON()` wire format
  (`"2026-08-27T10:15:30.123Z"`) rather than Python's default
  `.isoformat()` (`"...+00:00"`, microsecond precision).
- **Error-shape parity**: every route validates request bodies/query
  params manually (not via Pydantic auto-422) specifically so error
  responses match Express's hand-rolled `{"error": "..."}" messages
  byte-for-byte, including extra diagnostic fields
  (`{error, distanceMeters, minLength}` etc.).

## Not yet verified (needs a live Postgres + a running Node instance)

1. **Live request/response diffing** — the actual Phase 3 ask: hit both
   servers with identical requests against the same seeded dataset and
   diff status/headers/body byte-for-byte, across the full Jest test
   suite's cases (happy path + every documented edge case). Not run here
   — no live DB in this environment. `backend-py/tests/` has a small
   smoke-test file (`test_health_and_auth.py`) as a starting skeleton, not
   a full port of `backend/tests/**`.
2. **Geofence radius/tolerance edge cases** — haversine math was ported
   verbatim (same formula, same constants), but boundary-condition
   behavior (`distance == radius_meters` exactly) should be confirmed with
   real coordinate fixtures, ideally reusing whatever fixtures
   `backend/tests/utils/haversine.test.js` and
   `backend/tests/routes/visits.routes.test.js` already use.
3. **Day-boundary-hour edge cases** — `business_day.py`'s Python
   reimplementation of the JS `Date` arithmetic in `businessDay.js` should
   be checked against real timestamps straddling `DAY_BOUNDARY_HOUR`
   (default 5am IST), especially around a UTC-vs-IST calendar-date
   mismatch window.
4. **Auto-cutoff/absence-check timing** — the APScheduler jobs' actual
   fire behavior (30s startup delay, 15-min interval, and the
   1am/11pm-IST trigger conditions) needs a live run to confirm, not just
   a code read; `app/scheduler.py`'s advisory-lock guard in particular has
   never executed against a real Postgres instance.
5. **Idempotency replay behavior** — `idempotency_keys` round-trips
   through JSONB via explicit `::jsonb` casts and `json.dumps`/
   `json.loads`; never exercised against a live insert/replay cycle here.
6. **Cross-backend JWT validation** — "a token issued by Node validates
   against FastAPI and vice versa" depends only on matching
   `JWT_SECRET`/algorithm/claims, which are byte-identical by construction
   (see `app/core/security.py`), but this has not been tested by actually
   generating a token from one backend and verifying it against the other.
7. **Rate-limiter and CORS edge behavior under a real proxy** — see
   NOTES.md's "Open items" section (X-Forwarded-For hop-walking, helmet
   header version-pinning).

## How to run the live parity pass

1. Point `backend-py/.env` at the same Postgres database and the same
   `JWT_SECRET`/`GOOGLE_MAPS_API_KEY` as `backend/.env`.
2. Run both servers side by side: Node on `:3001` (`npm start` in
   `backend/`), Python on a different port, e.g. `:3002`
   (`uvicorn app.main:app --port 3002` in `backend-py/`, after
   `pip install -r requirements.txt`).
3. For each route in INVENTORY.md's table, replay every case from the
   matching `backend/tests/routes/*.test.js` file against both servers
   (same auth token, same body) and diff status code + JSON body
   (ignoring only truly non-deterministic fields like `id`/`created_at`
   where a fresh insert is involved).
4. Any difference found: **stop and report it — do not silently "fix" the
   Python side to look more correct than the Node side** per the task's
   own non-negotiable constraints. Flag it for a decision on which
   behavior is actually correct.
