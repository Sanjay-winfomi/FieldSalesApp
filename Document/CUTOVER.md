# Cutover Plan — Node/Express → Python/FastAPI (FieldTrack)

## Pre-cutover checklist

1. `backend-py/.env` set to the **exact same values** as `backend/.env` —
   especially `JWT_SECRET` (byte-identical, so tokens issued by either
   backend verify against the other), `DB_*`, `GOOGLE_MAPS_API_KEY`.
2. `pip install -r backend-py/requirements.txt` in a Python 3.11+ venv.
3. Run `uvicorn app.main:app --port 3002` (a different port than the Node
   app's 3001) side by side against the **same** Postgres database.
4. Run the Phase 3 parity checks (see PARITY_REPORT.md) — diff every route's
   status/headers/body between the two servers using a shared dataset.
5. Confirm both `/health` and `/health/deep` return 200 on the Python
   instance before routing any real traffic to it.
6. Confirm the APScheduler jobs actually start (log line "FieldTrack backend
   running" plus no scheduler startup errors) and — if this deployment ever
   runs more than one worker — confirm the `pg_try_advisory_lock` guard in
   `app/scheduler.py` prevents double-firing (see the Multi-worker safety
   section below).

## Rolling cutover strategy

Because both backends share:
- the same Postgres database (no schema changes),
- the same `JWT_SECRET`/algorithm/claims (`sub`/`role`/`username`),
- the same idempotency-key table (`idempotency_keys`),

...a token issued by one backend is valid against the other, and a
mobile/web client can be pointed at either backend mid-session without a
forced re-login. This makes a **traffic-percentage rolling cutover** safe:

1. Put both backends behind the same load balancer / reverse proxy target,
   or behind two separate hostnames with a client-side feature flag /
   staged rollout (whichever your deploy infra supports).
2. Start by routing a small percentage of traffic (e.g. read-only reps, or
   a single test manager account) to the Python backend.
3. Watch `backend-py/logs/error-*.log` and the manager-notification feed
   (`day_auto_cutoff`/`day_absent`/etc. notifications firing correctly)
   for the first full 24h cycle — this covers both self-scheduling sweeps'
   full daily trigger windows (1am and 11pm IST).
4. Increase the traffic percentage once confident. There is no data
   migration step — both backends write to the same tables the whole time,
   so a rep's session can move between backends mid-day, including mid-visit,
   without anything breaking (attendance/visit state lives in Postgres, not
   in either process's memory, except for the two things below).

### What does NOT survive moving a request from one backend to the other

- The 30-second employee-state auth cache (`app/core/security.py`) is
  per-process, in-memory. A request landing on the Python backend
  immediately after landing on the Node backend re-checks `is_active`/role
  fresh (cache miss) — this is strictly more correct than staying on one
  backend the whole time, never less. Not a concern.
- The geocode in-memory cache (`app/routers/geocode.py`) is also
  per-process. Moving between backends just means an occasional avoidable
  Google API call, not an inconsistency.
- Idempotency-Key responses ARE shared (they live in Postgres), so a mobile
  client's retry can hit either backend and still get the correct
  deduped response.

## Multi-worker safety (only relevant if the Python deployment runs more
## than one uvicorn/gunicorn worker process — the Node app never had this
## concern, it was always single-process)

`app/scheduler.py`'s `auto_cutoff`/`absence_check` jobs each wrap their run
in a non-blocking `pg_try_advisory_lock` so only one worker executes a given
15-minute tick; the others no-op. This is pure waste-avoidance, not a
correctness requirement — both sweeps are idempotent (`UPDATE ... WHERE
logout_time IS NULL AND ...`) and `absence_check`'s notification insert is
additionally guarded by a DB-level partial unique index
(`idx_manager_notifications_absent_dedup`), so even without the lock, two
workers racing on the same tick could not corrupt data or double-notify —
they'd just do some redundant work. Confirm in your deploy config how many
workers `uvicorn`/`gunicorn` will actually run before treating this as
either present or needed.

## Rollback plan

Rollback is just re-pointing traffic back to the Node backend — there is
**no data migration to reverse**, since both backends read/write the same
tables the whole time and neither one owns any state the other can't see.

1. Route 100% of traffic back to the Node backend (reverse whatever
   traffic-split mechanism was used for the rolling cutover).
2. Stop the Python backend process(es) — safe at any time, no drain period
   strictly required (in-flight requests will 5xx on the LB/proxy the same
   way any backend restart would; if you want a graceful drain, stop
   sending new traffic first, wait for in-flight requests to finish, then
   stop the process).
3. Nothing further to do — the Node app's own `autoCutoff`/`absenceCheck`
   sweeps resume owning those responsibilities the moment it's the only
   backend receiving traffic again (both apps' sweeps query the same table
   state, so there's no "catch-up" needed either way).
4. If the rollback happened mid-incident, check
   `backend-py/logs/error-*.log` for what went wrong before attempting
   cutover again.

## Known non-functional differences to watch for during parity testing

See NOTES.md's "Framework-level differences" section — rate-limiter
X-Forwarded-For hop-walking and helmet header version-pinning are the two
areas most likely to need a second look under a real production proxy
topology, since they were ported by re-implementing the underlying
algorithm rather than by using the identical library.
