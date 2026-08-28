# Port Notes — Node/Express → Python/FastAPI (FieldTrack)

Running log of assumptions, edge cases, and Node code smells noticed but
NOT changed during the port. See INVENTORY.md for the full spec of record.

## Framework-level differences (not behavior changes, just how the same
## behavior is achieved in Python)

- **Date column handling**: `backend/src/db/pool.js` installs a custom type
  parser for SQL `DATE` (OID 1082) to work around `pg` returning a JS `Date`
  at local midnight, which then serializes/shifts across a day boundary in
  IST. `asyncpg` has no equivalent bug — it returns `datetime.date`, which
  serializes as a plain `'YYYY-MM-DD'` string. No workaround needed; see
  `app/db/pool.py`'s module docstring.
- **Timestamp JSON format parity**: Node's `pg` + `res.json()` serialize
  `TIMESTAMPTZ` as `"2026-08-27T10:15:30.123Z"` (millisecond precision,
  literal `Z`) via `Date#toJSON()`. Python's `datetime.isoformat()` instead
  emits microsecond precision and a numeric offset (`+00:00`). Every route
  MUST pass raw query results through `app/utils/json_shape.py`'s
  `serialize_row()`/`serialize_rows()` before returning them, or the wire
  format will differ from the Node backend and could break a client that
  does exact string parsing.
- **JSONB params**: asyncpg has no default json/jsonb codec — every JSONB
  column write casts explicitly with `$N::jsonb` and `json.dumps()` on the
  Python side (see `app/services/idempotency.py`). Same convention used
  wherever else a JSONB column appears (e.g. `dealer_navigations.route_summary`,
  currently unused/always NULL per INVENTORY.md, so untouched).
- **Self-scheduling sweeps**: Node started `autoCutoff.js`/`absenceCheck.js`
  as import-time `setTimeout`/`setInterval` side effects. FastAPI has no
  import-time equivalent that's safe (a bare import must never itself run
  I/O) — these are registered explicitly via APScheduler in
  `app/scheduler.py`, wired up in `main.py`'s lifespan `on_startup`. Same
  30s startup delay + 15-min recurring interval as the Node code.
- **Multi-worker safety (new to the port, not a behavior change)**: the Node
  app was always a single process, so its sweeps never had to worry about
  two instances double-firing. If the FastAPI deployment ever runs more than
  one uvicorn/gunicorn worker, `app/scheduler.py` guards `auto_cutoff` and
  `absence_check` with a non-blocking `pg_try_advisory_lock` so only one
  worker executes a given tick (see Phase 4 discussion). This is additive
  safety, not a functional difference for a single-worker deployment.
- **CORS rejection**: ported as an actual 403 response from a Starlette
  middleware (`app/core/cors.py`), matching the Node app's `isCorsError`
  tagging + global error handler (which blocks the request server-side, not
  just omits the `Access-Control-Allow-Origin` header).
- **Rate limiting**: `slowapi` (limits-based) used in place of
  `express-rate-limit`; the client-IP resolution in `app/core/rate_limit.py`
  approximates Express's `trust proxy` numeric-hop algorithm for
  `X-Forwarded-For` — exact byte-for-byte parity with the `proxy-addr`
  library's hop-walking isn't verified beyond the common single-proxy case;
  flag if a multi-hop production topology needs exact matching.
- **Security headers**: `app/core/security_headers.py` hardcodes helmet
  8.3.0's documented default header set (helmet has no Python equivalent to
  literally import) — if the Node app's helmet version changes, this file
  needs manual re-sync.

## Business logic ported as-is (deliberately NOT "fixed")

- Google Routes API has **no haversine fallback** on the two hottest paths
  (dealer-to-dealer visit distance, day-logout final leg) — both hard-fail
  with `502 route_computation_failed` if Google is unreachable. Ported
  exactly; do not add a fallback.
- `dealers.radius_meters` has a DB-level `NOT NULL DEFAULT 200` — there is
  no live per-request env fallback via `LOGIN_RADIUS_METERS` anywhere except
  `GET /api/config` (a UI hint) and the dealer-creation SQL default.
- Manager-notification read-state (`read_at`/`dismissed_at`) is shared
  across ALL managers, not per-account — confirmed intentional in
  schema.sql's own comments.
- `GET /api/assignments/today` has no role check at all (implicit
  `req.employee.id` scoping only) — confirmed intentional, not a bug.
- Idempotency-Key support is inconsistent across routes in the Node app
  (present on attendance/visits/navigation-compute/followup-request POSTs,
  absent elsewhere) — ported exactly per-route, not applied uniformly.
- The 30-second employee-state auth cache has no proactive invalidation —
  a deactivation/role change takes up to 30s to take effect, same as Node.
- `assignments.routes.js`'s loose date params (GET `?date=`, PUT body
  `assignment_date`) and `navigation.routes.js`'s GET `/history?date=` all
  validate with bare `Date.parse()`, which is far more permissive than any
  single Python parser (accepts ISO-8601, RFC 2822, and many
  engine-specific formats, with V8-specific quirks). `app/routers/
  assignments.py`'s `_parse_date_param` and `app/routers/navigation.py`'s
  history date parsing approximate this with `datetime.fromisoformat`
  plus a few common fallback formats — this is NOT byte-for-byte parity
  with `Date.parse()` for exotic date strings, only for the ISO-8601
  strings every real client (mobile app, web dashboard) actually sends.
  Flag if a fuzzed/adversarial date-string test suite needs exact parity.
  (`followupRequests.routes.js`'s dates use a **strict** `YYYY-MM-DD` regex
  instead, per its own code comment — that one ports exactly, no gap.)

## Design deviation from Phase 1 brief: request validation approach

The Phase 1 plan called for "Pydantic v2 models mirroring each route's exact
request/response shape." In practice, most Node routes hand-roll validation
with route-specific error messages (`{"error": "lat and lng must be valid
numbers (-90..90, -180..180)"}`, `{"error": "gps_accuracy_exceeded",
accuracyMeters, thresholdMeters}`, etc.) — FastAPI's automatic Pydantic
validation instead returns a 422 with a structurally different error body
(`{"detail": [{"loc": [...], "msg": ..., "type": ...}]}`), which would break
API-contract parity for every route with custom validation. To preserve
exact error shapes/status codes, most routers read the raw body via
`await request.json()` and validate manually field-by-field, matching each
Node route's own checks 1:1 — see app/routers/attendance.py and visits.py.
Pydantic models are used only where the Node route's own validation is
simple presence/type checking with a single generic error (e.g.
app/routers/auth.py's `LoginBody`). `app/schemas/` is intentionally thin as
a result. Flag if you'd prefer full Pydantic models with a custom
exception handler reshaping 422s to match instead — that's a viable
alternative approach, just a larger diff.

## CLI-only scripts NOT ported (out of scope per task constraints)

`backend/src/db/migrate.js`, `seed.js`, `create-demo-manager.js` — schema
management and seed data stay owned by the Node codebase per the "same DB,
no schema changes" constraint. The Python port only ports the HTTP API
surface. `backend/fieldtrack.http` (a REST Client manual-test script) has no
Python equivalent and isn't needed for one.

## Env vars added that weren't in backend/.env.example

`LOG_DIR`, `LOG_LEVEL` — real, read by logger.js but missing from its own
.env.example (see INVENTORY.md §3). Added to `backend-py/.env.example`.
`SEED_ALLOW_PRODUCTION`/`ALLOW_DEMO_ACCOUNT` are CLI-script-only and not
applicable to the Python port (no equivalent scripts ported).

## Open items / to verify against a running Node instance

- Rate-limiter X-Forwarded-For hop-walking under a real multi-hop proxy —
  still unverified (no such proxy in the local validation environment).
  **The base rate-limit enforcement itself IS now verified**: both the
  general 200/15min limiter and the 20/15min login limiter were confirmed
  live against a running FastAPI instance (hammered `/api/auth/login` past
  20 attempts, got `429 {"error":"Too many login attempts, please try
  again in 15 minutes."}` — byte-identical to Node's own response body).
- Byte-for-byte helmet header parity if the Node `helmet` dependency is
  ever bumped past 8.3.0.
- CSV report output formatting — see COMPATIBILITY_REPORT.md's bug B6 for
  a real bug found and fixed here (hardcoded-UTC vs actual-local-timezone
  `Date#toString()` rendering).
