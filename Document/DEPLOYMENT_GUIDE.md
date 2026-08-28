# Deploying FastAPI to Production — Step-by-Step

You asked me to deploy FastAPI, switch the mobile/web app's production
target, run production smoke tests, and monitor errors. I don't have Render,
Vercel, or EAS credentials or dashboard access from this environment, and I
verified I have no general outbound network access either (a direct `curl`
to your production URL was blocked; a read-only fetch tool reached it but
can't run authenticated POST-based flows) — so I can't execute any of this
myself. This is the exact sequence for you (or whoever holds those
credentials) to run it.

I've already prepared everything that's safe to prepare without touching
production:
- `render.yaml` — added a `fieldtrack-backend-py` service block, alongside
  (not replacing) the existing Node service. It shares the same database
  and — critically — the same `JWT_SECRET` via Render's `fromService`
  cross-service reference, so you never need to see or copy the actual
  secret value by hand.
- `backend-py/scripts/production_smoke_test.py` — the exact flow you asked
  for (Login → Day Check-in → Dealer List → Dealer Check-in → Dealer
  Check-out → Day Check-out → Reports/Sync), ready to run against whichever
  URL you point it at.

## 1. Sanity-check the render.yaml change

I can't verify Render's exact current blueprint YAML schema against their
live API from here (no network access) — the `runtime: python`,
`fromService`, and `fromDatabase` keys match Render's documented blueprint
spec as of when this port was written, but Render's docs are the source of
truth. Before syncing: open Render's Blueprint docs and confirm
`runtime: python` and `fromService` are still current syntax, since I
cannot test this render.yaml against the real API myself.

## 2. Deploy the FastAPI service on Render

1. Push this branch (including the updated `render.yaml`) to the repo
   Render is watching, or open the Render dashboard → your Blueprint →
   "Sync" if it auto-detects `render.yaml` changes.
2. Render will create a new service, `fieldtrack-backend-py`, alongside
   the existing `fieldtrack-backend` (Node) — it does NOT touch or replace
   the Node service.
3. In the Render dashboard, set the two `sync: false` secrets on the new
   service (these are marked `sync: false` because Render blueprints never
   auto-populate secrets — you set them once in the dashboard):
   - `ALLOWED_ORIGINS` — same value as the Node service already has.
   - `GOOGLE_MAPS_API_KEY` — same value as the Node service already has.
4. Watch the build/deploy logs in Render's dashboard for
   `fieldtrack-backend-py`. It should show `pip install -r requirements.txt`
   succeeding, then uvicorn starting, then the `/health` check passing.
5. Once it's live, note its URL (Render assigns something like
   `https://fieldtrack-backend-py-xxxx.onrender.com` — copy the exact one
   Render gives you).

## 3. Verify before touching any client config

Hit `https://<your-new-service>.onrender.com/health` and
`/health/deep` directly (browser or `curl`) — `/health/deep` round-trips
the database, so a 200 there confirms it can actually reach the same DB the
Node service uses.

Then run the smoke test from a machine that HAS real network access
(this sandbox doesn't):

```bash
cd backend-py
pip install -r requirements.txt   # if not already
BASE_URL=https://<your-new-service>.onrender.com \
TEST_USERNAME=<a real or dedicated QA username> \
TEST_PASSWORD=<that account's password> \
DEALER_ID=<a dealer id with coordinates different from the check-in point> \
  python scripts/production_smoke_test.py
```

**Use a dedicated QA/test account if one exists, not a real rep's account**
— this script performs REAL writes (a real day check-in/check-out, a real
dealer visit) against whatever database `BASE_URL` points to. If no QA
account exists, consider creating one first (`POST /api/employees` as a
manager) rather than using a real rep's login.

Read the script's output top to bottom — every step prints its status code
and timing; the first `FAIL` line tells you exactly which step broke and
the response body. It exits non-zero on any unexpected status.

**Recommended first run**: point `BASE_URL` at the OLD Node service first,
confirm the script passes end-to-end there (proves the script itself is
correct, not testing FastAPI at all), THEN re-run with `BASE_URL` pointed
at the new FastAPI service and compare.

## 4. Switch the mobile app's production target

The real value lives in `mobile/eas.json`, in both the `preview` and
`production` build profiles:

```diff
  "env": {
-   "EXPO_PUBLIC_API_URL": "https://fieldtrack-backend-kvmt.onrender.com/api"
+   "EXPO_PUBLIC_API_URL": "https://<your-new-service>.onrender.com/api"
  }
```

**This does not take effect for already-installed app copies.** Confirmed:
`mobile/app.json` has an `updates` block pointing at
`https://u.expo.dev/bf38c17c-1a63-4e81-ac28-3b8410400462`, and
`expo-updates` is in `mobile/package.json` — EAS Update IS configured for
this app. That means:

- **`eas update --branch production`** (or whichever branch your production
  build's `channel` maps to — `mobile/eas.json`'s `production` profile uses
  channel `"production"`) pushes the new JS bundle, including this baked-in
  URL, to already-installed copies over-the-air, with **no app-store
  review**. This is the fast path.
- A full `eas build --profile production` + store submission is only
  needed for a *native* code change (this API-URL switch is JS-only, so it
  isn't one) — but confirm your EAS Update rollout policy/audience settings
  before publishing, since a bad OTA update reaches existing users
  immediately with no review gate to catch it first.
- `--profile preview` builds (internal distribution) are still useful for
  validating the switch with a small group before publishing the OTA update
  to the full production channel.

Given the review-gated nature of a production mobile release, **strongly
consider validating FastAPI in production for a while via the `preview`
profile and/or the backend-only rolling cutover (both backends live, only
some traffic routed to FastAPI at the load-balancer/DNS level if your infra
supports it) before shipping a `production` mobile build that commits every
user to the new backend at once.**

## 5. Switch the web app's production target

`NEXT_PUBLIC_API_URL` is not in this repo — it's set in whatever platform
hosts the web app in production (the `render.yaml` comment referencing a
Vercel URL suggests Vercel). In that platform's dashboard:

1. Find the `NEXT_PUBLIC_API_URL` environment variable for the production
   environment.
2. Change it to `https://<your-new-service>.onrender.com/api`.
3. Trigger a redeploy (Next.js inlines this at build time — changing the
   env var alone does nothing until the next build).

## 6. Monitor immediately after cutover

I have no access to any production monitoring/error-tracking tool from
here, so I can't watch this for you. What to actually watch, in order of
signal quality:

1. **Render's own dashboard logs** for `fieldtrack-backend-py` — tail them
   live during and immediately after the mobile/web switch. Look
   specifically for the `error`-level JSON lines this app emits (structured
   logging — every unhandled error logs `{"level": "error", "message": ...,
   "error": ..., "stack": ...}`), and for a spike in 401/500 status codes
   in Render's request logs.
2. **`GET /health/deep`** on a short interval (even a simple uptime-monitor
   ping every 1-5 min) — catches "process is up but DB is unreachable"
   distinctly from a full outage.
3. Whatever your actual app-side crash/error reporting is (Sentry or
   similar, if configured in `mobile/`/`web/` — I did not find one in this
   codebase during the earlier port; if none exists, that's itself worth
   knowing before a rollout this size).
4. **CUTOVER.md**'s rollback section (repo root) — if anything looks wrong,
   routing traffic back to the Node service is the fast, safe path: nothing
   about this cutover requires a data migration to reverse, since both
   backends read/write the same tables the whole time.
