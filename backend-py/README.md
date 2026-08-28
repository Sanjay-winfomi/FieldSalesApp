# FieldTrack Backend (FastAPI)

The REST API for FieldTrack — attendance, dealer visits, assignments,
navigation, reports, and the manager dashboard's data. Originally a 1:1 port
of a Node/Express backend (see `../Document/` for the migration history);
that Node backend has since been retired and this is the only backend now.

## Running locally

```bash
cd backend-py
python -m venv .venv
# Windows: .venv\Scripts\activate    macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# Edit .env: point DB_* at a real Postgres instance, and set JWT_SECRET and
# GOOGLE_MAPS_API_KEY.

uvicorn app.main:app --reload --port 3001
```

- `GET /health` — liveness, no I/O.
- `GET /health/deep` — readiness, round-trips the database.
- Interactive API docs at `/docs` (FastAPI's built-in Swagger UI).

## Running tests

```bash
pip install -r requirements-dev.txt
pytest
```

Tests run against a real Postgres instance (`DB_*` env vars, same as the
app itself) and set `NODE_ENV=test` (silences file logging).

## Project layout

```
app/
  main.py            FastAPI app: boot checks, middleware, routers, health
  scheduler.py        APScheduler wiring for the self-scheduling sweeps
                       (auto-cutoff, absence-check, idempotency cleanup,
                       employee-state cache sweep)
  core/               config, JWT auth, rate limiting, CORS, security
                       headers, logging
  db/pool.py          asyncpg connection pool (raw SQL, no ORM)
  routers/            one file per API resource (auth, attendance, visits,
                       dealers, assignments, navigation, reports, ...)
  services/           Google Routes API client, notifications, idempotency,
                       dealer-assignment side effects
  utils/              haversine, business-day math, auto-cutoff/
                       absence-check sweep logic, response-shape helpers
scripts/
  production_smoke_test.py   sequential login→checkin→checkout→reports
                              smoke test against a live deployment
tests/                pytest suite — route tests (mocked DB) and a small
                       set of real-app/real-DB smoke tests
```

## Deployment

Deployed to Render via `../render.yaml` (Blueprint). See that file for the
required environment variables.
