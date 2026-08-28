# Winfomi FieldTrack

Field-sales attendance and dealer-visit tracking: a mobile app for reps
(day check-in/out, dealer check-in/out, GPS geofencing) and a web dashboard
for managers (live attendance, dealer/rep map, reports, notifications).

## Repository layout

```
backend-py/   FastAPI backend — REST API, Postgres, JWT auth, scheduled sweeps
web/          Next.js manager dashboard
mobile/       Expo/React Native app for field reps
Document/     Migration reports and internal notes (not part of the app)
render.yaml   Render Blueprint for backend-py
```

## Stack

| Part        | Tech                                                              |
|-------------|--------------------------------------------------------------------|
| Backend     | Python, FastAPI, asyncpg (raw SQL, no ORM), APScheduler, PyJWT, slowapi |
| Database    | PostgreSQL                                                        |
| Web         | Next.js, React                                                    |
| Mobile      | Expo / React Native                                                |
| Maps        | Google Maps JavaScript API (web), Google Routes API (backend)     |

The backend was originally built in Node/Express and later ported 1:1 to
Python/FastAPI (same DB schema, same API contract, same JWT behavior). The
Node version has been retired; `backend-py` is the only backend now.

## Running locally

Each part has its own README with full setup instructions:

- [backend-py/README.md](backend-py/README.md)
- `web/` — `npm install && npm run dev` (needs `web/.env` — see `web/.env.example`)
- `mobile/` — `npm install && npm start` (needs `mobile/.env` — see `mobile/.env.example`)

All three need to agree on:
- The backend's base URL (`NEXT_PUBLIC_API_URL` in web, `EXPO_PUBLIC_API_URL` in mobile)
- A Google Maps API key with the relevant APIs enabled (Maps JavaScript API
  for web, Geocoding/Places/Routes APIs for the backend)

## Deployment

- **Backend** — Render, via `render.yaml` (Blueprint). Health check at `/health`.
- **Web** — Vercel, auto-deploys from `main`.
- **Mobile** — Expo/EAS. `eas update` for JS-only changes (OTA, no store
  review), `eas build` when native code or config changes.

## Tests

- `backend-py`: `pytest` (real Postgres required — see backend-py/README.md)
- `web`: `npm test` (vitest)
- `mobile`: `npm test` (jest)
