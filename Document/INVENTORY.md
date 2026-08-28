# FieldTrack Backend Inventory (Node/Express) — Spec of Record for Python/FastAPI Port

Source: `backend/` at commit-of-record 2026-08-27. Compiled by reading every file in
`src/`, `.env.example`, `package.json`, `README.md`, and skimming `tests/**`.

---

## 0. Boot sequence (src/index.js)

1. `dotenv().config()` loads `.env`.
2. Global `unhandledRejection` / `uncaughtException` handlers registered (log; `uncaughtException` calls `process.exit(1)`).
3. All route modules `require`d.
4. Side-effect-only `require('./utils/autoCutoff')` and `require('./utils/absenceCheck')` — this **starts** their internal `setTimeout`/`setInterval` sweeps merely by importing the module (no explicit "start()" call).
5. **Fail-fast checks** (throw synchronously, before `app.listen`):
   - `JWT_SECRET` must be set at all — else throws.
   - If `NODE_ENV === 'production'` AND `JWT_SECRET === 'fieldtrack_jwt_secret_change_in_production_2026'` (the exact .env.example placeholder string) — throws.
   - If `NODE_ENV === 'production'` AND `ALLOWED_ORIGINS` is unset — throws (see CORS section).
6. `app.set('trust proxy', parseInt(TRUST_PROXY_HOPS || '1'))` — **only when `NODE_ENV === 'production'`**.
7. `helmet()` applied globally (default helmet config, no custom directives).
8. CORS middleware (see §7).
9. `express.json()` (default body size limit — no explicit `limit` override in code, so Express's own default ~100kb applies).
10. Rate limiters mounted (see §7).
11. `GET /health` — no I/O, returns `{status:'ok', time}`.
12. `GET /health/deep` — runs `SELECT 1` against pool; 200 if ok, 503 `{status:'degraded'}` if DB unreachable.
13. Public: `app.use('/api/auth', authRouter)`.
14. Protected (requireAuth only): attendance, visits, dealers, geocode, notes, reminders, sync-failures, assignments, navigation, followup-requests.
15. `GET /api/config` (requireAuth only) → `{ loginRadiusMeters: parseInt(LOGIN_RADIUS_METERS || '200') }`.
16. Manager-only (requireAuth + requireRole('manager')): dashboard, employees, reports, notifications.
17. 404 catch-all → `{ error: "Route not found: <METHOD> <path>" }`.
18. Global error handler: CORS errors (`err.isCorsError`) → 403 `{error:'Origin not allowed'}`; everything else → 500 `{error:'Internal server error'}` (logs full stack server-side only).
19. `app.listen(PORT)`. `module.exports = app` (used by supertest in tests).

---

## 1. Route table

Legend: **RA** = requireAuth (global, applied at index.js mount), **RR(x)** = requireRole(x).
All routers below are mounted with RA already applied at the app.use level in index.js
except /api/auth (public). Manager-only routers (dashboard/employees/reports/notifications)
have RA + RR(manager) applied at mount; individual route-level requireRole calls are
called out explicitly.

Standard error shape across almost all routes: { error: "message" }, sometimes with
extra diagnostic fields (e.g. { error, distanceMeters, minLength }). 500 body is always
generic { error: 'Internal server error' } -- never leaks err.message to the client.

### auth (/api/auth) -- public, but rate-limited (loginLimiter on /login, /refresh, /forgot-password)

| Method | Path | Middleware | Auth | Body | Response | Status | Notes |
|---|---|---|---|---|---|---|---|
| POST | /login | loginLimiter | none | username, password | accessToken, refreshToken, employee | 200, 400, 401 (Username not found / Incorrect password -- distinct messages, deliberately not generic), 500 | Username lookup is LOWER(username)=LOWER(param). Inactive employee -> 401 Username not found. |
| POST | /refresh | loginLimiter | none | refreshToken | accessToken | 200, 400, 401 (Invalid refresh token / Refresh token expired / Employee not found) | Verifies payload.type === refresh. Re-fetches employee to check is_active. |
| POST | /forgot-password | loginLimiter | none | username, phone, new_password | success:true | 200, 400 (missing fields / password<6), 401 (Username not found / Phone number does not match our records), 500 | Phone matched via normalizePhone(): strip non-digits, take last 10. bcrypt cost 10. |

### attendance (/api/attendance) -- RA at mount

| Method | Path | MW | Auth | Body/Query | Response | Status | Notes |
|---|---|---|---|---|---|---|---|
| POST | /login | RA | any | work_mode?, lat, lng, accuracy_meters? (Idempotency-Key header optional) | attendance record | 201, 400, 422 (gps_accuracy_exceeded), 409 (Already logged in today), 500 | work_mode 'field'(default)/'office'. Field mode requires lat/lng; office mode optional. Accuracy gate only enforced on field mode. Atomic via ON CONFLICT (employee_id,business_date) DO NOTHING unique partial index. Idempotency-Key supported (attendance/login endpoint key). Office-day fires fire-and-forget office_day manager notification. |
| POST | /logout | RA | any | attendance_id, lat, lng, accuracy_meters? | attendance + summary | 200, 400, 404, 409 (Already logged out today), 422 (gps_accuracy_exceeded, field-mode only), 502 (route_computation_failed), 500 | Wrapped in one DB transaction with SELECT...FOR UPDATE row lock on attendance. Auto-closes any still-open dealer visit using this logout's GPS (flagged visit_auto_closed_on_day_logout notification, sent only after COMMIT). Computes "final leg" (last visit logout or day login -> this point) via Google Routes API -- NO haversine fallback; failure returns 502 with message "Request timed out -- Retry". Fires notifyUnvisitedAssignments (fire-and-forget) after commit. |
| GET | /today | RA | any | -- | attendance/visits | 200, 500 | Scoped to current business day via isCurrentBusinessDay('login_time'). |
| GET | / | RA | any (reps see own only) | from=, to=, employee_id= (manager only) | attendance list (max 1000) | 200, 400 (invalid employee_id), 500 | Reps: ignore employee_id, forced to own id. from/to filtered on business-date expr. |
| GET | /:id | RA | any (owner or manager) | -- | attendance record | 200, 400, 403, 404, 500 | |

### visits (/api/visits) -- RA at mount

| Method | Path | MW | Auth | Body/Query | Response | Status | Notes |
|---|---|---|---|---|---|---|---|
| POST | /login | RA | any | attendance_id, dealer_id, lat, lng, accuracy_meters, reason? | visit + dealer_name | 201, 400, 404 (attendance/dealer not found), 409 (visit_already_open), 422 (gps_accuracy_exceeded / reason_required), 502 (route_computation_failed), 500 | accuracy_meters REQUIRED (unlike attendance). Radius check via haversine vs dealers.radius_meters; no coords => treated as inside. Reason (>=20 chars, MIN_REASON_LENGTH) required if outside radius. Distance-from-previous computed via Google Routes API only (no fallback) -- 502 on failure. Transaction w/ SELECT...FOR UPDATE on attendance row to block concurrent check-ins. Inserts exception_log row + login_exception manager notification if outside radius. Fires markAssignmentVisited (fire-and-forget). |
| POST | /logout | RA | any | visit_id, lat, lng, accuracy_meters, reason? | visit + needs_verification | 200, 400, 404, 409 (Visit already logged out), 422 (gps_accuracy_exceeded / reason_required), 500 | matched_login: logout GPS within LOGIN_MATCH_TOLERANCE_METERS (20) of login GPS counts as "same spot" even if outside dealer radius. Reason (50-500 chars, LOGOUT_EXCEPTION_REASON_MIN/MAX) required if login was already an exception OR currently outside & not drift-matched. needs_verification = login exception AND outOfRadius (Case 3). Fires needs_verification or logout_exception notification. |
| POST | /:id/location-check | RA | any | lat, lng (accuracy not required here) | visit, distance_meters, rep_notification | 200, 400, 404, 500 | Periodic ~10-min in-visit ping. Atomic CTE UPDATE snapshotting old state. 2nd cumulative outside-radius check trips log_out_alert_sent+interrupted (legacy mechanism) and inserts exception_log type interrupted. SEPARATE/ADDITIVE staged alert system via visit_radius_events: every RADIUS_ALERT_STAGE_MINUTES=10 min continuously outside advances a stage; stage1(10min)=manager-only left_dealer; stage2(20min)=rep-only "Time to log out?"; stage3+(30min,+10min repeating)=both (still_outside to manager). CAS-based race protection (WHERE alert_count=$prev) so concurrent pings don't double-fire. Returning inside closes the open visit_radius_events row and sends returned notification (only if >=1 alert stage had fired). |
| GET | / | RA | any (reps own only) | from=, to=, dealer_id=, employee_id= (manager) | visits list (max 1000, w/ derived needs_verification) | 200, 400, 500 | |
| GET | /exceptions | RA + RR(manager) | manager | employee_id=, dealer_id=, reviewed=, from=, to= | exceptions list (max 1000, incl. needs_verification derived via correlated EXISTS) | 200, 400, 500 | Registered before /:id. |
| PATCH | /exceptions/:id | RA + RR(manager) | manager | reviewed?: boolean (default true unless explicitly false) | exception:{id,manager_reviewed} | 200, 400, 404, 500 | |
| GET | /:id | RA | any (owner or manager) | -- | visit + needs_verification | 200, 400, 403, 404, 500 | |

### dealers (/api/dealers) -- RA at mount

| Method | Path | MW | Auth | Body/Query | Response | Status | Notes |
|---|---|---|---|---|---|---|---|
| GET | / | RA | any | search= | dealers list | 200, 500 | search matched ILIKE against name/address, LIKE metachars escaped. |
| GET | /not-visited | RA + RR(manager) | manager | days=7 | dealers list, threshold_days | 200, 400 (days<=0/non-int), 500 | days=0 explicitly rejected (not silently defaulted). |
| POST | / | RA + RR(manager) | manager | name, address?, latitude?, longitude?, contact_person?, contact_phone?, radius_meters? | dealer record | 201, 400, 500 | radius_meters defaults to 200 via SQL COALESCE. lat/lng range validated if provided. |
| PUT | /:id | RA + RR(manager) | manager | same fields, all optional (COALESCE-preserve) | dealer record | 200, 400, 404, 500 | |
| DELETE | /:id | RA + RR(manager) | manager | -- | success:true, deletedVisitCount | 200, 400, 404, 500 | Cascades (schema FK ON DELETE CASCADE) to client_visits, exception_log, visit_radius_events, manager_notifications, reminders, dealer_assignments/followup_requests (via those tables' own FKs). Counts pending followup requests + not-yet-completed future assignments up front, transaction-wrapped; posts dealer_deleted_with_pending_work notification after commit if any existed. |

### dashboard (/api/dashboard) -- RA + RR(manager) at mount

| Method | Path | Response | Status | Notes |
|---|---|---|---|---|
| GET | /today | reps list, generated_at | 200, 500 | Per-rep status derived: not_logged_in/day_ended/logged_in with computed last_activity string. needs_logout_alert = open visit with log_out_alert_sent. |
| GET | /rep/:id/today | employee, attendance, visits | 200, 400, 404, 500 | visits include radius_left_at from open visit_radius_events. |
| GET | /map | dealers, reps, generated_at | 200, 500 | Reps missing both lat/lng are filtered out. Each rep's next_assignment from first pending/navigating assignment today. |

### employees (/api/employees) -- RA + RR(manager) at mount

| Method | Path | Body | Response | Status | Notes |
|---|---|---|---|---|---|
| GET | / | role= | employees list (PUBLIC_FIELDS, no password_hash) | 200, 500 | |
| POST | / | name,phone?,username,password,role,region? | employee record | 201, 400 (missing/role invalid/password<6), 409 (username exists), 500 | bcrypt cost 10. Username uniqueness case-insensitive. |
| PUT | /:id | name?,phone?,region?,role?,is_active? | employee record | 200, 400, 404, 500 | 'key' in req.body distinguishes omitted vs explicit-null for phone/region (allows clearing). Empty-string name explicitly rejected. |
| DELETE | /:id | -- | success:true | 200, 400 (self-delete blocked), 404, 500 | Hard delete, cascades to attendance/visits/exception_log. Self-delete blocked (id === req.employee.id). |
| POST | /:id/reset-password | password | success:true | 200, 400 (<6 chars), 404, 500 | |

### reports (/api/reports) -- RA + RR(manager) at mount

| Method | Path | Query | Response | Status | Notes |
|---|---|---|---|---|---|
| GET | /attendance | from=&to=&employee_id=&employee_ids=&format=csv|json | rows/count/truncated JSON or CSV | 200, 400, 500 | ROW_CAP=2000; truncated flag if hit cap (JSON body field or X-Report-Truncated header for CSV). |
| GET | /dealer-visits | same + dealer_id | same shape | 200, 400, 500 | includes derived needs_verification. |
| GET | /distance-duration | same | same (per-employee rollup) | 200, 400, 500 | |
| GET | /exceptions | same + dealer_id | same | 200, 400, 500 | Excludes event_type=interrupted unconditionally. |
| GET | /absences | from=&to=&employee_id=&employee_ids=&format= | same | 200, 400, 500 | Mirrors day_absent manager_notifications; sorted by derived absence_date not created_at. |
| (all) | | | CSV excludes ID_LIKE_KEYS = [id, employee_id, dealer_id, attendance_id, visit_id] | | date strings validated strictly YYYY-MM-DD (DATE_ONLY_RE), employee_ids (CSV of ints) takes precedence over singular employee_id. |

### geocode (/api/geocode) -- RA at mount (any authenticated employee)

| Method | Path | Query | Response | Status | Notes |
|---|---|---|---|---|---|
| GET | /search | q= | found, candidates (<=5) | 200, 400, 502 | Google Geocoding API forward. Cached 10 min (search:q_lower key). |
| GET | /reverse | lat=&lng= | address, raw | 200, 400, 502 (fallback returns coord string as address) | Cache key rounded to 4 decimals (~11m). raw maps Google address_components to flat fields for mobile compat. |
| GET | /nearby | lat=&lng=&radius= (clamped 1-500, default 150) | places (<=30) | 200, 400, 502 | Uses Places API (New) searchNearby. |
| GET | /autocomplete | input=&sessiontoken= | predictions (<=6) | 200, 502 | No cache (per-keystroke). Input<3 chars -> empty predictions, no call. includedRegionCodes:[in]. |
| GET | /place-details | place_id=&sessiontoken= | latitude, longitude, display_name | 200, 400, 502 | Cached by place_id. |
| (all) | | | 8s upstream timeout (UPSTREAM_TIMEOUT_MS), in-memory Map cache TTL 10 min, no eviction sweep (grows unbounded until process restart). | | |

### notes (/api/notes) -- RA at mount

| Method | Path | Body | Response | Status | Notes |
|---|---|---|---|---|---|
| POST | / | content (>=100 chars trimmed) | note record | 201, 422 (content_too_short), 500 | |
| GET | / | employee_id= (manager only) | notes list (<=500) | 200, 400, 500 | |
| GET | /:id | -- | note record | 200, 400, 403, 404, 500 | |
| PUT | /:id | content | note record | 200, 400, 403, 404, 422, 500 | Owner-only. |
| DELETE | /:id | -- | success:true | 200, 400, 403, 404, 500 | Owner-only. |

### reminders (/api/reminders) -- RA at mount

| Method | Path | Body | Response | Status | Notes |
|---|---|---|---|---|---|
| POST | / | dealer_id, reminder_date, note (note >=20 chars) | reminder record | 201, 400, 404 (dealer), 422 (reminder_date_in_past / note_too_short), 500 | reminder_date validated strictly YYYY-MM-DD; past-check against getBusinessDateString(). |
| GET | / | employee_id= (manager only) | reminders list (<=500, incl. dealer_name) | 200, 400, 500 | |
| PATCH | /:id/notifications | notif_id_day_before?, notif_id_day_of? | reminder record | 200, 400, 403, 404, 500 | Owner-only; persists client-scheduled local notification ids. |
| DELETE | /:id | -- | success:true | 200, 400, 403, 404, 500 | Owner-only. |

### sync-failures (/api/sync-failures) -- RA at mount, any employee

| Method | Path | Body | Response | Status | Notes |
|---|---|---|---|---|---|
| POST | / | method?, url, error? | success:true, deduped? | 201, 400, 500 | Dedupes identical employee+method+url sync_failure notification within DEDUP_WINDOW_MINUTES=60 (LIKE-based match on body, metachars escaped). Creates sync_failure (danger severity) manager notification otherwise. |

### assignments (/api/assignments) -- RA at mount, role checks per-route

| Method | Path | MW | Auth | Body/Query | Response | Status | Notes |
|---|---|---|---|---|---|---|---|
| GET | / | RR(manager) | manager | employee_id=&date= | assignments list | 200, 400, 500 | date defaults to current business day if omitted. |
| PUT | / | RR(manager) | manager | employee_id, assignment_date, dealer_ids (ordered ints) | assignments list | 200, 400, 404 (rep/dealer not found), 500 | De-dupes dealer_ids preserving order. Transaction + pg_advisory_xact_lock(hashtext('dealer_assignments:'||employee_id||':'||date)). DELETE-then-upsert; upsert never resets status/created_at for already-completed dealers. |
| DELETE | /:id | RR(manager) | manager | -- | success:true | 200, 400, 404, 500 | |
| GET | /today | (RA only, no role check) | any (rep's own) | -- | assignments list w/ latest nav | 200, 500 | Scoped to req.employee.id implicitly (no employee_id param). |

### navigation (/api/navigation) -- RA at mount, role checks per-route

| Method | Path | MW | Auth | Body/Query | Response | Status | Notes |
|---|---|---|---|---|---|---|---|
| POST | /compute | RA | any | dealer_id, assignment_id?, origin_lat, origin_lng | navigation record | 201, 400, 404 (dealer/assignment), 422 (dealer_missing_coordinates), 502, 500 | Idempotency-Key supported. assignment_id (if given) must match dealer_id AND belong to caller. Advances linked assignment to navigating unless already cancelled/completed/arrived. |
| POST | /distance-preview | RA | any | origin_lat, origin_lng, dest_lat, dest_lng | distanceMeters, durationSeconds, durationInTrafficSeconds | 200, 400, 502 | Read-only, no persistence, no idempotency key. |
| PATCH | /:id/status | RA | any (owner) | status in navigating/arrived/completed/cancelled | navigation:{id,status,ended_at} | 200, 400, 403, 404, 500 | Rank-guarded mirror onto linked assignment (completed=3 > arrived=2 > navigating=1 > else 0); never downgrades or resurrects a cancelled assignment; cancelled nav never propagates. |
| GET | /history | RR(manager) | manager | employee_id=&date=&page=&limit= (limit clamped 1-100, default 20) | navigations, total, page, pageCount | 200, 400, 500 | |
| GET | /summary/today | RA | any (own) | -- | totals object (see below) | 200, 500 | Only counts assignment-linked navigations (assignment_id IS NOT NULL), scoped to today's business date. Fields: total_assigned_dealers, visited_dealers, pending_dealers, total_planned_distance_m, distance_travelled_m, remaining_distance_m, total_driving_time_s, estimated_remaining_time_s, completed_visits, pending_visits. |

### followup-requests (/api/followup-requests) -- RA at mount, role checks per-route

| Method | Path | MW | Auth | Body/Query | Response | Status | Notes |
|---|---|---|---|---|---|---|---|
| POST | / | RR(rep) | rep | dealer_id, assignment_id?, requested_date, reason (reason >=10 chars) | request record | 201, 400, 404 (dealer/assignment), 422 (requested_date_in_past / reason_too_short), 500 | Idempotency-Key supported. Awaits (not fire-and-forget) followup_request manager notification. |
| GET | / | RR(manager) | manager | status=pending|approved|rejected | requests list (<=200) | 200, 400, 500 | |
| PATCH | /:id/approve | RR(manager) | manager | approved_date? | request, assignment_id | 200, 400, 404, 409 (request_already_resolved), 422 (approved_date_in_past), 500 | Transaction + same advisory lock as PUT /assignments (serializes with it). Atomic pending->approved claim before creating assignment. sequence_order = MAX+1 (appended). Reactivates a cancelled existing assignment row to pending on conflict; leaves other statuses untouched. |
| PATCH | /:id/reject | RR(manager) | manager | -- | request record | 200, 400, 404, 409, 500 | Atomic WHERE status='pending' claim. |

### notifications (/api/notifications) -- RA + RR(manager) at mount

| Method | Path | Body | Response | Status | Notes |
|---|---|---|---|---|---|
| GET | / | -- | notifications list (<=200, WHERE dismissed_at IS NULL) | 200, 500 | Joins employee/dealer names + linked followup_request status/dates. |
| GET | /unread-count | -- | count | 200, 500 | WHERE read_at IS NULL AND dismissed_at IS NULL. Registered before /:id. |
| POST | /read-all | -- | success:true | 200, 500 | Excludes REQUIRES_EXPLICIT_REVIEW = [day_auto_cutoff, visit_auto_cutoff, day_absent] types. |
| PATCH | /:id/read | -- | notification:{id,read_at} | 200, 400, 404, 500 | read_at = COALESCE(read_at, NOW()) -- idempotent. |
| DELETE | /:id | -- | success:true | 200, 400, 404 (not found, or not yet reviewed/resolved), 500 | Deletable only if: (type in REQUIRES_EXPLICIT_REVIEW AND read) OR (type=followup_request AND its request is approved/rejected). day_absent is soft-dismissed (dismissed_at), never hard-deleted (guards absenceCheck's dedup re-triggering). |
| DELETE | / | -- | success:true, deleted:N | 200, 500 | Bulk version of the same rule. |

---

## 2. Schema breakdown (schema.sql)

Note: schema.sql is a single idempotent migration file, full of IF NOT EXISTS / rename
DO dollar-dollar blocks for legacy column names (check_in_star to login_star etc). The table below
describes the CURRENT, FINAL shape only.

### employees
- id SERIAL PK
- name VARCHAR(150) NOT NULL
- phone VARCHAR(20)
- username VARCHAR(80) NOT NULL UNIQUE
- password_hash VARCHAR(255) NOT NULL
- role VARCHAR(20) NOT NULL CHECK IN (rep, manager)
- region VARCHAR(100)
- is_active BOOLEAN NOT NULL DEFAULT TRUE
- created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
- Index: idx_employees_username

### dealers
- id SERIAL PK, name VARCHAR(200) NOT NULL, address TEXT
- latitude/longitude DOUBLE PRECISION (nullable, no registered coords means treated as inside radius, fallback used everywhere)
- contact_person VARCHAR(150), contact_phone VARCHAR(20)
- created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
- radius_meters INTEGER NOT NULL DEFAULT 200, per-dealer geofence override. Code comment confirms every row always has a value, so no further fallback is needed (visits.routes.js). LOGIN_RADIUS_METERS env var is a system-wide fallback only used to seed the default for dealers created before this column existed, it is NOT re-read per-request except by /api/config (exposed as loginRadiusMeters suggested-default for the web dealer-editor UI).
- Index: idx_dealers_created_at

### attendance
- id SERIAL PK, employee_id INT NOT NULL FK to employees ON DELETE CASCADE
- business_date DATE (nullable but effectively always set at login; drives the atomic one-login-per-business-day unique constraint)
- login_time/login_lat/login_lng, logout_time/logout_lat/logout_lng
- total_distance_km DOUBLE PRECISION DEFAULT 0
- total_duration_minutes INTEGER
- sync_status VARCHAR(20) NOT NULL DEFAULT synced, CHECK IN (synced, pending)
- final_leg_distance_km DOUBLE PRECISION, final_leg_is_routed BOOLEAN NOT NULL DEFAULT FALSE
- work_mode VARCHAR(10) NOT NULL DEFAULT field, CHECK IN (field, office)
- created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
- Indexes: idx_attendance_employee_id, idx_attendance_login_time
- UNIQUE idx_attendance_employee_business_date on (employee_id, business_date) WHERE business_date IS NOT NULL, backs the atomic already-logged-in-today INSERT ON CONFLICT DO NOTHING guard.

### client_visits
- id SERIAL PK, attendance_id INT NOT NULL FK to attendance ON DELETE CASCADE, dealer_id INT NOT NULL FK to dealers (ON DELETE CASCADE per the dealer-cascade retrofit block)
- login_time/login_lat/login_lng, logout_time/logout_lat/logout_lng
- visit_duration_minutes INT, distance_from_previous_km DOUBLE PRECISION DEFAULT 0
- out_of_radius BOOLEAN NOT NULL DEFAULT FALSE
- login_justification_note TEXT, logout_justification_note TEXT
- sync_status VARCHAR(20) NOT NULL DEFAULT synced, CHECK IN (synced, pending)
- login_accuracy_m/logout_accuracy_m DOUBLE PRECISION
- login_distance_m/logout_distance_m DOUBLE PRECISION
- login_inside_radius BOOLEAN (nullable, tri-state; false means login used an exception)
- matched_login BOOLEAN NOT NULL DEFAULT FALSE
- interrupted BOOLEAN NOT NULL DEFAULT FALSE, interrupted_at TIMESTAMPTZ, interrupted_distance_m DOUBLE PRECISION
- last_location_status VARCHAR(10), last_location_check_at TIMESTAMPTZ, outside_radius_count INT NOT NULL DEFAULT 0, log_out_alert_sent BOOLEAN NOT NULL DEFAULT FALSE
- last_location_distance_m DOUBLE PRECISION
- distance_is_routed BOOLEAN NOT NULL DEFAULT FALSE
- created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
- Indexes: idx_visits_attendance_id, idx_visits_dealer_id, idx_visits_created_at, idx_visits_login_time

### exception_log
- id SERIAL PK, employee_id FK to employees CASCADE, dealer_id FK to dealers (CASCADE via retrofit), visit_id FK to client_visits ON DELETE CASCADE (nullable)
- event_type VARCHAR(12) NOT NULL CHECK IN (login, logout, interrupted)
- latitude/longitude DOUBLE PRECISION NOT NULL, distance_meters, gps_accuracy_m DOUBLE PRECISION
- reason TEXT (nullable, interrupted events have none)
- matched_login BOOLEAN NOT NULL DEFAULT FALSE
- manager_reviewed BOOLEAN NOT NULL DEFAULT FALSE
- created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
- Indexes: employee_id, created_at, dealer_id, visit_id

### notes
- id SERIAL PK, employee_id FK to employees CASCADE
- content TEXT NOT NULL, CHECK char_length(TRIM(content)) is at least 100, DB-level enforcement, not just app-level
- created_at/updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
- Indexes: employee_id, created_at

### reminders
- id SERIAL PK, employee_id FK to employees CASCADE, dealer_id FK to dealers (CASCADE via retrofit)
- reminder_date DATE NOT NULL
- note TEXT NOT NULL, CHECK char_length(TRIM(note)) is at least 20
- notif_id_day_before/notif_id_day_of TEXT (client-generated OS notification ids)
- created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
- Indexes: employee_id, reminder_date, dealer_id

### idempotency_keys
- key VARCHAR(100) PRIMARY KEY, employee_id FK to employees CASCADE (nullable)
- endpoint VARCHAR(100) NOT NULL, response_status INT NOT NULL, response_body JSONB NOT NULL
- created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
- Index: created_at (used by 24h retention cleanup)

### visit_radius_events
- id SERIAL PK, visit_id FK to client_visits CASCADE, employee_id FK to employees CASCADE, dealer_id FK to dealers CASCADE
- left_at TIMESTAMPTZ NOT NULL, returned_at TIMESTAMPTZ (nullable = still open)
- alert_count INT NOT NULL DEFAULT 0, max_distance_m DOUBLE PRECISION
- created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
- Indexes: visit_id, dealer_id, employee_id
- UNIQUE idx_visit_radius_events_open on (visit_id) WHERE returned_at IS NULL, enforces at most one open excursion per visit; app catches Postgres error code 23505 on insert conflict.

### manager_notifications
- id SERIAL PK, type VARCHAR(40) NOT NULL, title VARCHAR(150) NOT NULL, body TEXT NOT NULL
- severity VARCHAR(20) NOT NULL DEFAULT info, CHECK IN (info, warning, danger)
- employee_id FK to employees ON DELETE SET NULL (retrofitted from CASCADE), dealer_id FK to dealers CASCADE (retrofit), visit_id FK to client_visits CASCADE
- read_at TIMESTAMPTZ (nullable), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
- followup_request_id INT FK to dealer_followup_requests ON DELETE SET NULL
- business_date DATE (nullable; only meaningful for type day_absent)
- dismissed_at TIMESTAMPTZ (nullable; soft-delete flag for day_absent rows)
- Indexes: created_at, partial index WHERE read_at IS NULL (unread), dealer_id, employee_id, visit_id, followup_request_id
- UNIQUE idx_manager_notifications_absent_dedup on (employee_id, business_date) WHERE type is day_absent, dedupe guard for absenceCheck sweep races.

### dealer_assignments
- id SERIAL PK, employee_id FK to employees CASCADE, dealer_id FK to dealers CASCADE
- assignment_date DATE NOT NULL, sequence_order INT NOT NULL
- assigned_by FK to employees ON DELETE SET NULL
- status VARCHAR(20) NOT NULL DEFAULT pending, CHECK IN (pending, navigating, arrived, completed, cancelled)
- created_at/updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
- UNIQUE (employee_id, dealer_id, assignment_date)
- Indexes: (employee_id,assignment_date), assignment_date, dealer_id, assigned_by

### dealer_navigations
- id SERIAL PK, assignment_id FK to dealer_assignments ON DELETE SET NULL, employee_id FK to employees CASCADE, dealer_id FK to dealers CASCADE
- status VARCHAR(20) NOT NULL DEFAULT navigating, CHECK IN (navigating, arrived, completed, cancelled)
- origin_latitude/origin_longitude DOUBLE PRECISION
- distance_meters INT, duration_seconds INT, duration_in_traffic_seconds INT
- expected_arrival_time TIMESTAMPTZ, encoded_polyline TEXT, route_summary JSONB (unused by any route currently, always NULL)
- started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), ended_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
- Indexes: (employee_id,started_at), assignment_id, dealer_id

### dealer_followup_requests
- id SERIAL PK, employee_id FK to employees CASCADE, dealer_id FK to dealers CASCADE
- assignment_id FK to dealer_assignments ON DELETE SET NULL
- requested_date DATE NOT NULL
- reason TEXT NOT NULL, CHECK char_length(TRIM(reason)) is at least 10
- status VARCHAR(20) NOT NULL DEFAULT pending, CHECK IN (pending, approved, rejected)
- approved_date DATE (nullable until resolved)
- resolved_by FK to employees ON DELETE SET NULL, resolved_at TIMESTAMPTZ
- created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
- Indexes: status, employee_id, dealer_id, assignment_id, resolved_by

### Columns with fallback logic when absent/null
- dealers.latitude/longitude NULL leads to geofence check treated as always inside (visits.routes.js login/logout/location-check all special-case this).
- dealers.radius_meters is NOT NULL with DB default 200, so no runtime fallback needed (env LOGIN_RADIUS_METERS only used at dealer-creation-time default and in /api/config, never re-read as a live fallback in the visit-radius code paths).
- client_visits dealer_lat/lng via join, same no-coords-means-inside rule for /location-check and /logout.
- GPS_ACCURACY_THRESHOLD_METERS, LOGIN_MATCH_TOLERANCE_METERS env vars parsed with Number.isFinite guards, fall back to hardcoded defaults (30, 20) if env value is non-numeric.
- DAY_BOUNDARY_HOUR parsed once at module load; invalid/out-of-range (not 0-23 int) silently falls back to 5.

---

## 3. Environment variables

| Name | Purpose | Read in | Default/example | Required in prod? |
|---|---|---|---|---|
| DB_HOST | Postgres host | pool.js, migrate.js, seed.js, create-demo-manager.js | localhost | yes (real value) |
| DB_PORT | Postgres port | same | 5432 | |
| DB_NAME | Database name | same | fieldtrack | |
| DB_USER | Postgres user | same | postgres | |
| DB_PASSWORD | Postgres password | same | (blank) | yes |
| DB_SSL | Enable SSL for PG connection | same | false | yes on managed hosts (Render/Heroku/RDS) |
| DB_SSL_REJECT_UNAUTHORIZED | Verify server cert when DB_SSL=true | same | true | |
| DB_POOL_MAX | pg Pool max connections | pool.js | 10 | |
| DB_IDLE_TIMEOUT_MS | pg Pool idle timeout | pool.js | 30000 | |
| DB_CONNECTION_TIMEOUT_MS | pg connect timeout | pool.js (5000 default), migrate.js/seed.js/create-demo-manager.js (10000 default, inconsistent default between pool.js and the CLI scripts) | 5000 (pool) / 10000 (scripts) | |
| JWT_SECRET | HMAC signing secret for access+refresh JWTs | auth.middleware.js, auth.routes.js, index.js (fail-fast check) | placeholder string in .env.example | yes, must not be placeholder in prod, enforced, throws at boot |
| JWT_EXPIRES_IN | Access token TTL | auth.routes.js | 8h | |
| JWT_REFRESH_EXPIRES_IN | Refresh token TTL | auth.routes.js | 7d | |
| PORT | HTTP listen port | index.js | 3001 | |
| NODE_ENV | Environment mode | index.js, logger.js, seed.js, create-demo-manager.js | development | set to production in prod |
| TRUST_PROXY_HOPS | number of reverse-proxy hops trusted for X-Forwarded headers | index.js | 1 | only applied when NODE_ENV=production |
| ALLOWED_ORIGINS | Comma-separated explicit CORS allowlist | index.js | unset (commented out) | yes in production, enforced, throws at boot if unset |
| LOGIN_RADIUS_METERS | Default dealer geofence radius, legacy fallback plus /api/config suggested value | index.js (/api/config); dealers.routes.js does NOT read it directly (radius_meters column has its own DB default) | 200 | no |
| GPS_ACCURACY_THRESHOLD_METERS | Max acceptable GPS accuracy in meters for attendance/visit login/logout | attendance.routes.js, visits.routes.js | 30 | no |
| LOGIN_MATCH_TOLERANCE_METERS | Max drift in meters between login/logout GPS to count as same spot | visits.routes.js | 20 | no |
| DAY_BOUNDARY_HOUR | Hour (0-23 IST) the business day rolls over | businessDay.js | 5 | no, read once at startup |
| GOOGLE_MAPS_API_KEY | Google Geocoding/Places/Routes API key | geocode.routes.js, googleRoutesService.js | (blank) | yes, if geocoding/routing features used |
| LOG_DIR | Winston file-transport output directory | logger.js | repo backend/logs | MISSING from .env.example |
| LOG_LEVEL | Winston log level | logger.js | debug in dev, info in prod | MISSING from .env.example |
| SEED_ALLOW_PRODUCTION | Override guard blocking seed.js in prod | seed.js | unset | MISSING from .env.example, CLI-script-only var |
| ALLOW_DEMO_ACCOUNT | Override guard blocking create-demo-manager.js in prod | create-demo-manager.js | unset | MISSING from .env.example, CLI-script-only var |

Gaps found: LOG_DIR, LOG_LEVEL, SEED_ALLOW_PRODUCTION, ALLOW_DEMO_ACCOUNT are read in code
but absent from .env.example. No env var is in .env.example but unused in code.

---

## 4. Third-party integrations

### Google Geocoding API (legacy maps.googleapis.com)
- GET https://maps.googleapis.com/maps/api/geocode/json?address=QUERY&key=KEY (forward geocode, /api/geocode/search)
- GET https://maps.googleapis.com/maps/api/geocode/json?latlng=LAT,LNG&key=KEY (reverse geocode, /api/geocode/reverse)
- Auth: key query param.
- Response envelope always 200 OK with internal status field (OK/ZERO_RESULTS/REQUEST_DENIED/etc), code treats anything other than OK/ZERO_RESULTS as an error.
- 8s timeout (UPSTREAM_TIMEOUT_MS), no retry.

### Google Places API (New) (places.googleapis.com/v1)
- POST /places:searchNearby, body maxResultCount 20, locationRestriction circle center latitude/longitude radius, fieldMask places.displayName,places.location,places.types (/api/geocode/nearby)
- POST /places:autocomplete, body input, includedRegionCodes [in], sessionToken optional (/api/geocode/autocomplete)
- GET /places/PLACE_ID?sessionToken=TOKEN, fieldMask location,formattedAddress (/api/geocode/place-details)
- Auth: X-Goog-Api-Key header (plus X-Goog-FieldMask header where applicable). Errors via normal HTTP status plus JSON body (data.error.message).
- 8s timeout, no retry.

### Google Routes API (Compute Routes, routes.googleapis.com)
- POST https://routes.googleapis.com/directions/v2:computeRoutes
- Exact request body fields:
  - origin.location.latLng.latitude = originLat, origin.location.latLng.longitude = originLng
  - destination.location.latLng.latitude = destLat, destination.location.latLng.longitude = destLng
  - travelMode = DRIVE
  - routingPreference = TRAFFIC_AWARE
  - computeAlternativeRoutes = false
  - units = METRIC
  - languageCode = en-US
- Headers: Content-Type application/json, X-Goog-Api-Key GOOGLE_MAPS_API_KEY, X-Goog-FieldMask routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.travelAdvisory
- Timeout: UPSTREAM_TIMEOUT_MS = 8000 ms via AbortSignal.timeout.
- Retry: MAX_ATTEMPTS = 2, RETRY_DELAY_MS = 500, retried only on network error/timeout, HTTP 429, or HTTP 500+. Non-retryable: 4xx except 429, or no route found.
- Never calls Route Optimization/Fleet Routing (single origin to destination only, matching the fixed assignment order).
- Callers: visits.routes.js (POST /visits/login, dealer-to-dealer leg, NO haversine fallback, 502 on failure), attendance.routes.js (POST /attendance/logout, final leg, NO haversine fallback, 502 on failure), navigation.routes.js (POST /navigation/compute and /navigation/distance-preview).
- Cost note per README: billed per call, not free-tier like Geocoding/Places, roughly 6 calls/day per rep with 5 visits.

No SMS/push/email provider integrations exist anywhere in the codebase, confirmed by
managerNotifications.js's own doc comment stating there is no push-notification
infrastructure in this app; managers are web-dashboard-only. Mobile reminder notifications
(notif_id_day_before/notif_id_day_of) are scheduled client-side (local device
notifications); the backend only stores the resulting ids for later cancellation, never
triggers them.

---

## 5. Background / self-scheduling behaviors

Both sweeps below are started as import-time side effects, index.js does
require(./utils/autoCutoff) and require(./utils/absenceCheck) with no exported
start function; the module body itself schedules a setTimeout plus setInterval,
both unref()'d so they never keep the Node process alive on their own (relevant for tests).

### autoCutoff.js
- Trigger instant: most recent 1:00 AM IST at-or-before NOW() (CUTOFF_INSTANT_EXPR, computed via a CASE checking whether the current IST time-of-day is at or after 01:00:00).
- Schedule: STARTUP_DELAY_MS = 30 times 1000 (30s) one-shot setTimeout after every boot, PLUS SWEEP_INTERVAL_MS = 15 times 60 times 1000 (15 min) recurring setInterval. Idempotent, safe to re-run.
- Query/condition (visits): UPDATE client_visits SET logout_time to cutoff, visit_duration_minutes via GREATEST(0,...), logout_justification_note set to a fixed auto-closed message, WHERE logout_time IS NULL AND login_time is before the cutoff.
- Side effect: for each closed visit, posts a visit_auto_cutoff (severity warning) manager notification. No GPS/route data set (logout_lat/lng left NULL, unlike a real logout).
- Query/condition (attendance): UPDATE attendance SET logout_time to cutoff, total_duration_minutes via GREATEST(0,...) WHERE logout_time IS NULL AND login_time is before the cutoff.
- Side effect: posts a day_auto_cutoff (severity warning) manager notification per closed row.
- Order: visits swept before attendance (conventional, no data dependency).

### absenceCheck.js
- Trigger condition: for each of the last LOOKBACK_DAYS=2 plus today, meaning 3 business dates, once that date's own 11:00 PM IST has passed, every active rep (role rep and is_active true) with no attendance row for that business_date AND no existing day_absent notification for that employee plus business_date is flagged.
- Schedule: same pattern, STARTUP_DELAY_MS = 30 times 1000 one-shot plus SWEEP_INTERVAL_MS = 15 times 60 times 1000 recurring setInterval.
- Side effect: createManagerNotification with type day_absent, severity danger, per flagged (employee, business_date) pair, protected against duplicate inserts by the DB's own partial unique index (ON CONFLICT on employee_id,business_date WHERE type is day_absent DO NOTHING), so concurrent sweeps across app instances cannot double-notify.
- No leave/roster concept, flags weekends/holidays too if the company does not route around this.

### idempotency.js (also self-scheduling, worth listing alongside)
- CLEANUP_INTERVAL_MS = 60 times 60 times 1000 (1 hour) recurring setInterval, unref()'d.
- Deletes idempotency_keys rows with created_at older than RETENTION_MS (24 hours, 86400000 milliseconds).

### auth.middleware.js employee-state cache sweep (also self-scheduling)
- ACTIVE_STATUS_CACHE_TTL_MS = 30 times 1000 (30s) recurring setInterval, unref()'d, evicts any cache entry whose age is at or beyond the TTL (not just on next request).

### businessDay.js, DAY_BOUNDARY_HOUR mechanics
- DAY_BOUNDARY_HOUR env var parsed once at module load; valid only if an integer 0 to 23, else silently falls back to 5. Changing the env var requires a server restart to take effect.
- businessDateExpr(timestampExpr) produces a SQL fragment: DATE of the expression shifted to Asia/Kolkata timezone minus an interval of DAY_BOUNDARY_HOUR hours.
- isCurrentBusinessDay(timestampExpr) compares businessDateExpr(expr) to businessDateExpr(NOW()).
- getBusinessDateString(now optional) is the JS-side equivalent: shifts now back by DAY_BOUNDARY_HOUR hours, then formats in Asia/Kolkata via Intl.DateTimeFormat with calendar en-CA, producing YYYY-MM-DD. Used wherever a route needs today without a DB round trip (reminders/followup-requests past-date validation).
- Interacts with autoCutoff (1 AM IST fixed cutoff, independent of DAY_BOUNDARY_HOUR) and absenceCheck (11 PM IST fixed threshold per business date, also independent of DAY_BOUNDARY_HOUR, only the set of business dates checked depends on the boundary hour, not the 11pm/1am instants themselves). All three ultimately anchor to the fixed Asia/Kolkata timezone regardless of server locale/UTC clock.

---

## 6. Auth / session behavior (auth.middleware.js plus auth.routes.js)

Access token (JWT, HS256 default via jsonwebtoken's jwt.sign, secret is JWT_SECRET)
- Claims: sub is employee.id, role is employee.role, username is employee.username
- Expiry: JWT_EXPIRES_IN env, default 8h.

Refresh token
- Claims: sub is employee.id, type is refresh
- Expiry: JWT_REFRESH_EXPIRES_IN env, default 7d.
- POST /api/auth/refresh verifies payload.type equals refresh, re-fetches employee (must exist and be active), issues a new access token only (the refresh token itself is never rotated/reissued).

requireAuth middleware, step by step
1. Requires an Authorization Bearer TOKEN header (else 401, missing or malformed Authorization header).
2. jwt.verify(token, JWT_SECRET), on TokenExpiredError returns 401 Token expired; any other verify failure returns 401 Invalid token.
3. Calls getEmployeeState(payload.sub) (see cache below).
4. If state.isActive is false, returns 401 Account is deactivated.
5. Sets req.employee to id from payload.sub, role from state.role falling back to payload.role, username from payload.username. Role is read fresh from the DB (via cache), not from the JWT payload, so a role change (promotion/demotion) or deactivation takes effect within the cache TTL, not waiting for token expiry.

30-second TTL cache mechanism, exact behavior
- Module-level Map called employeeStateCache, keyed by employeeId (numeric, from payload.sub).
- ACTIVE_STATUS_CACHE_TTL_MS equals 30 times 1000, 30 seconds, hardcoded constant, not env-configurable.
- Cache value shape: isActive boolean, role string or null, time equal to Date.now() at fetch.
- Cache hit: if a cached entry exists and Date.now() minus cached.time is less than the TTL, it is returned as-is, no DB query.
- Cache miss: runs SELECT is_active, role FROM employees WHERE id equals the param; builds a state object where isActive is true only if a row exists and its is_active column is exactly true, role falls back to null if missing, time is Date.now(). This state ALWAYS overwrites the map entry (even if the employee no longer exists, an isActive-false state gets cached too, so a deleted employee's stale token still gets fast-pathed to a 401 for the next 30s without a DB hit).
- Invalidation: none explicit, entries are simply overwritten on the next request past TTL from the same employee. There is no cross-request invalidation trigger (an admin deactivating a user does NOT proactively clear that user's cache entry, it just naturally expires within roughly 30s on their next request).
- Sweep: a separate setInterval every ACTIVE_STATUS_CACHE_TTL_MS (30s), unref()'d, deletes any entry whose age is at or beyond the TTL, purely a memory-leak guard (entries for employees who never make another request would otherwise sit forever), not part of the invalidation logic itself.

requireRole(role) middleware
- Returns 401 Not authenticated if req.employee is missing (should be unreachable given requireAuth always runs first, but guarded anyway).
- Returns 403 Requires role plus the role name, if req.employee.role does not equal the required role.
- Single-role only (no array/OR support), every manager-only/rep-only route calls this with exactly one literal role string.

---

## 7. Rate limiting, CORS, security headers

### Rate limiting (express-rate-limit)
- General API limiter (apiLimiter), mounted on /api/: windowMs is 15 times 60 times 1000 (15 min), max is 200 requests per IP, standardHeaders true, legacyHeaders false, body on limit is an error message about too many requests, try again later.
- Login limiter (loginLimiter), mounted on /api/auth/login, /api/auth/refresh, AND /api/auth/forgot-password (all three share the strict limiter, refresh and forgot-password are treated as equally sensitive to brute-force/replay): windowMs is 15 times 60 times 1000, max is 20 requests per IP, body is an error message about too many login attempts, try again in 15 minutes.
- Both limiters key on req.ip, which depends on the trust proxy setting (only enabled in production, hops equal TRUST_PROXY_HOPS default 1), in dev all requests share the same apparent IP unless behind a real proxy.
- No separate limiter exists for any other route (no per-route limiter on /api/geocode paths despite proxying paid Google APIs, relies solely on the blanket 200 per 15min /api/ limiter).

### Security headers
- helmet() applied globally with all default directives, no custom CSP, no override options passed. (Precise default set depends on the installed helmet major version, caret 8.3.0 per package.json, a port replicating byte-for-byte parity should match helmet at version 8's exact default header list.)

### CORS (exact fallback logic)
- helmet() then cors() middleware, credentials true always.
- If NODE_ENV equals production and ALLOWED_ORIGINS is unset, the process refuses to boot (throws in index.js, before the CORS middleware is even reached).
- If ALLOWED_ORIGINS is set (comma-separated, no trimming/normalization of entries, exact string match against the Origin header): only origins in that exact list are allowed; anything else triggers a CORS error (tagged with isCorsError true on the error object), surfaced by the global error handler as 403 Origin not allowed. A rejected origin also logs a warning naming the rejected origin.
- If ALLOWED_ORIGINS is unset (dev-only, since prod requires it): falls back to a private-LAN allowlist via a regex matching localhost, 127.0.0.1, and the RFC 1918 private ranges 10.0.0.0/8, 172.16.0.0 through 172.31.0.0/12, and 192.168.0.0/16, tested against the hostname parsed out of the Origin URL, on any port, any scheme (explicitly includes exp:// for Expo Go, the code parses hostname via the URL constructor, not a scheme-specific regex). A URL that fails to parse is treated as rejected (fail-closed), not allowed.
- Requests with no Origin header at all are always allowed, covering server-to-server/curl/mobile-native fetches that do not send Origin.
- Every rejected private-LAN-fallback origin also logs a warning.

---

## 8. Gaps / corrections vs. the assumed task summary

1. Env vars undocumented in .env.example: LOG_DIR, LOG_LEVEL (logger.js), SEED_ALLOW_PRODUCTION (seed.js guard), ALLOW_DEMO_ACCOUNT (create-demo-manager.js guard). All four are real, read in code, and should be captured in the port's config spec.
2. radius_meters fallback: the task prompt asked to note fallback logic when absent/null for dealers.radius_meters, but in the current schema this column is NOT NULL with a DB default of 200, so there is no runtime null-fallback anywhere in route code; the only place the LOGIN_RADIUS_METERS env var is actually read at request time is GET /api/config (as a UI suggested-default) and the dealer INSERT's SQL-level COALESCE to 200. Do not assume a live per-request env fallback exists for radius, it does not.
3. Additional route worth flagging: POST /api/employees/:id/reset-password is a POST-with-body action route, not simple CRUD, grouped under employees.
4. CLI-only scripts not covered by the prompt's directory list but present and load-bearing for the port: backend/src/db/create-demo-manager.js (creates a demo manager account, guarded by ALLOW_DEMO_ACCOUNT), and fieldtrack.http (a REST Client manual-test script, not automated).
5. Google Routes API has NO haversine fallback on the two hottest paths (dealer login distance-from-previous, and day-logout final leg), despite haversine.js's own doc comment listing 3 usages including logout total_distance_km accumulation. In practice, visits.routes.js login and attendance.routes.js logout both now hard-fail (502 route_computation_failed, message Request timed out, Retry) if the Routes API call fails, rather than silently degrading to a straight-line estimate. Haversine is still used for the radius/geofence checks (login/logout/location-check distance-to-dealer) and is NOT used for any distance-traveled totals anymore in the current code, this is a materially different behavior than a naive reading of haversine.js's own header comment would suggest, and matters for port fidelity (a FastAPI port must replicate Routes-API-failure-means-502-no-fallback exactly, not silently improve it with a haversine fallback).
6. DB_CONNECTION_TIMEOUT_MS has two different effective defaults: 5000 in pool.js (the live app's connection pool) versus 10000 in migrate.js/seed.js/create-demo-manager.js (one-off CLI scripts). Not a bug, but a port must replicate per-script defaults, not assume one global default.
7. Idempotency-Key is inconsistently supported, present on: attendance login/logout, visits login/logout/location-check, navigation/compute, followup-requests POST. Absent on: dealers CRUD, employees CRUD, notes, reminders, assignments PUT, notifications actions, sync-failures POST (has its own separate time-window LIKE-based dedup instead, not idempotency-key based). The port must not assume blanket idempotency-key coverage.
8. Manager-notification read-state is explicitly documented as shared across all managers (not per-manager-account), manager_notifications.read_at/dismissed_at are single columns, not a join table. This is called out in code as a documented simplification, not a bug. A FastAPI port preserving 1:1 behavior must keep this shared (non-per-manager) semantics rather than fixing it into per-manager read state.
9. GET /api/assignments/today has no requireRole at all (unlike every other /api/assignments path, which are all manager-only), it is implicitly rep-scoped only because it queries WHERE employee_id equals req.employee.id with no employee_id parameter accepted at all; a manager calling it would just see their own (nonexistent, since managers have no assignments) rows, not an error. Confirm this is intentional (README/tests suggest yes: rep access, no manager role required) when porting the auth-decorator equivalent.
10. CORS explicit-list matching is exact string equality, not case-insensitive or normalized (no scheme/port defaulting), an ALLOWED_ORIGINS value will NOT match a differently-cased or trailing-slash variant. Preserve this literal behavior in the port unless asked to relax it.
11. express.json() has no explicit size limit override, relies on Express's built-in default (100kb as of Express 4.x body-parser). Not called out anywhere in code/env; the FastAPI port should pick an explicit equivalent rather than silently inheriting a different framework default.
12. helmet() uses all-default config, no CSP customization visible anywhere in the codebase; a byte-identical port of security headers requires matching helmet at version 8.3.0's specific default header set, not just adding some security headers.
