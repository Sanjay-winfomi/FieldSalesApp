# FieldTrack Backend (Python/FastAPI port)

A 1:1 port of `../backend` (Node/Express) to Python/FastAPI. Same
PostgreSQL database, same schema, same API contract — see `../INVENTORY.md`
for the full route/schema spec of record and `../NOTES.md` for porting
decisions and known differences.

## Running alongside the Node backend, against the same database

Both backends read/write the same Postgres tables and accept/issue
JWTs against the same secret — they can run side by side, even against
live traffic, with no data migration step. See `../CUTOVER.md` for the
full rolling-cutover and rollback plan.

```bash
cd backend-py
python -m venv .venv
# Windows: .venv\Scripts\activate    macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# Edit .env: point DB_* at the SAME database backend/.env uses, and copy
# JWT_SECRET and GOOGLE_MAPS_API_KEY across byte-for-byte.

uvicorn app.main:app --reload --port 3002
```

The Node app defaults to port 3001 (`PORT` in `backend/.env`) — run the
Python app on a different port (e.g. 3002 above) if running both at once
locally.

- `GET /health` — liveness, no I/O.
- `GET /health/deep` — readiness, round-trips the database.
- Interactive API docs at `/docs` (FastAPI's built-in Swagger UI) — useful
  for manual parity spot-checks against `backend/fieldtrack.http`.

## Running tests

```bash
pip install -r requirements-dev.txt
pytest
```

Tests run against a real Postgres instance (`DB_*` env vars, same as the
app itself) and set `NODE_ENV=test` (silences file logging, matching the
Node test suite's own convention). `tests/` currently has a smoke-test
skeleton, not a full port of `backend/tests/**` — see PARITY_REPORT.md for
what's verified and what still needs a live side-by-side pass against the
Node backend.

## Project layout

```
app/
  main.py           FastAPI app: boot checks, middleware, routers, health
  scheduler.py       APScheduler wiring for the two self-scheduling sweeps
  core/              config, JWT auth, rate limiting, CORS, security headers, logging
  db/pool.py         asyncpg connection pool (raw SQL, no ORM)
  routers/           one file per Express route module
  services/          Google Routes API client, notifications, idempotency,
                      dealer-assignment side effects
  utils/             haversine, business-day math, auto-cutoff/absence-check
                      sweep logic, response-shape (JSON) parity helpers
```

## What's deliberately NOT ported here

Schema migrations, seed data, and the demo-account CLI script stay owned
by the Node codebase (`backend/src/db/migrate.js`, `seed.js`,
`create-demo-manager.js`) — this port covers the HTTP API surface only, per
the "same DB, no schema changes" constraint. See NOTES.md for the full list.
