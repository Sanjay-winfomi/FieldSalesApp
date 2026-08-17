/**
 * visits.routes.js — Stage 5 + Dealer Geofencing & GPS Validation spec
 *
 * POST /api/visits/login  — log in at a dealer (blocked outside radius w/o justification)
 * POST /api/visits/logout — log out of a dealer (blocked outside radius w/o a written reason,
 *                             unless the logout GPS matches the login GPS within tolerance)
 * GET  /api/visits/exceptions       — manager-only: list out-of-radius events
 * PATCH /api/visits/exceptions/:id  — manager-only: mark an exception reviewed
 * POST /api/visits/:id/location-check — periodic in-visit GPS ping (every ~10
 *   min while a visit is open), used to show a live Inside/Outside Radius
 *   status and to accumulate a cumulative out-of-radius count for the
 *   "time to log out" alert.
 */
const express             = require('express');
const logger = require('../utils/logger');
const pool                = require('../db/pool');
const { haversineKm }     = require('../utils/haversine');
const { computeRoute }    = require('../services/googleRoutesService');
const { logDealerLogin, logDealerLogout, logVisitInterrupted } = require('../utils/activityLog');
const { requireRole }     = require('../middleware/auth.middleware');
const { getIdempotentResponse, saveIdempotentResponse } = require('../utils/idempotency');
const { createManagerNotification } = require('../utils/managerNotifications');
const { markAssignmentVisited } = require('../utils/dealerAssignments');
const { businessDateExpr } = require('../utils/businessDay');

const router = express.Router();

// A non-numeric env value would otherwise silently disable this gate
// entirely (any accuracyMeters > NaN is always false) with no warning.
const parsedGpsThreshold = parseInt(process.env.GPS_ACCURACY_THRESHOLD_METERS, 10);
const GPS_ACCURACY_THRESHOLD_M = Number.isFinite(parsedGpsThreshold) ? parsedGpsThreshold : 30;
const parsedMatchTolerance = parseInt(process.env.LOGIN_MATCH_TOLERANCE_METERS, 10);
const MATCH_TOLERANCE_M = Number.isFinite(parsedMatchTolerance) ? parsedMatchTolerance : 20;
const MIN_REASON_LENGTH         = 20;

// Logout-specific reason bounds — required whenever the visit's LOGIN
// already used an exception, or the rep is currently outside the dealer
// radius at logout time (and not drift-matched to the login spot).
// Stricter than MIN_REASON_LENGTH (login's own rule, unchanged) since this
// is the rep's one chance to explain a logout a normal in-radius visit
// never needs to reach this branch for.
const LOGOUT_EXCEPTION_REASON_MIN = 50;
const LOGOUT_EXCEPTION_REASON_MAX = 500;

// Staged radius-excursion alerts (Task 4): every 10 minutes continuously
// outside the dealer radius advances one stage — 1st (10min) manager-only,
// 2nd (20min) rep-only, 3rd+ (30min, and every 10min after) both. Computed
// from the excursion's elapsed time, not from how many polls have landed, so
// it's correct regardless of whether visitMonitor.js's foreground poll or
// geofenceTask.js's background geofence event is what triggers the check.
const RADIUS_ALERT_STAGE_MINUTES = 10;

// Coerces lat/lng to finite numbers within valid geographic ranges, or null.
function parseCoord(value, min, max) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

// Coerces GPS accuracy to a finite, non-negative number, or null if absent/invalid.
function parseAccuracy(value) {
  if (value === undefined || value === null) return null;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/visits/login
// ──────────────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { attendance_id, dealer_id, reason } = req.body;
  const employeeId = req.employee.id;

  if (!attendance_id || !dealer_id || req.body.lat === undefined || req.body.lng === undefined) {
    return res.status(400).json({ error: 'attendance_id, dealer_id, lat, and lng are required' });
  }
  const lat = parseCoord(req.body.lat, -90, 90);
  const lng = parseCoord(req.body.lng, -180, 180);
  if (lat === null || lng === null) {
    return res.status(400).json({ error: 'lat and lng must be valid numbers (-90..90, -180..180)' });
  }
  const accuracyMeters = parseAccuracy(req.body.accuracy_meters);
  if (accuracyMeters === null) {
    return res.status(400).json({ error: 'accuracy_meters is required' });
  }
  if (accuracyMeters > GPS_ACCURACY_THRESHOLD_M) {
    return res.status(422).json({ error: 'gps_accuracy_exceeded', accuracyMeters, thresholdMeters: GPS_ACCURACY_THRESHOLD_M });
  }

  const idempotencyKey = req.get('Idempotency-Key') || null;

  // A dedicated client + transaction (rather than pool.query per statement)
  // so the attendance row can be locked with SELECT ... FOR UPDATE for the
  // duration of the open-visit check + insert. Without this, two
  // near-simultaneous check-ins for the same attendance_id (double-tap, or
  // an offline queue flushing two check-ins close together) could both read
  // "no open visit" before either inserts, creating two open visits and
  // corrupting distance_from_previous_km chaining plus every downstream
  // "current visit" assumption. The FOR UPDATE lock serializes the second
  // request behind the first's commit, so it correctly sees the first
  // request's now-open visit.
  const client = await pool.connect();
  let dealer;
  let visit;
  let insideRadius;
  let trimmedReason;
  let distanceM;

  try {
    // A retried request (e.g. the mobile client's cold-start retry) that
    // already created a visit replays that result instead of inserting a
    // second open visit — this route has no other guard against that.
    const cached = await getIdempotentResponse(idempotencyKey, employeeId, 'visits/login');
    if (cached) {
      return res.status(cached.response_status).json(cached.response_body);
    }

    await client.query('BEGIN');

    // Verify attendance belongs to this employee and the day hasn't been
    // ended yet, locking the row so a concurrent check-in for the same
    // attendance_id waits for this transaction to finish.
    const attResult = await client.query(
      `SELECT id, login_lat, login_lng FROM attendance
       WHERE id = $1 AND employee_id = $2 AND logout_time IS NULL
       FOR UPDATE`,
      [attendance_id, employeeId]
    );
    if (attResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Attendance record not found, or the day has already ended' });
    }
    const att = attResult.rows[0];

    // A rep can only have one open visit at a time — logging in at a second
    // dealer without logging out of the first would corrupt
    // distance_from_previous_km (computed from the last logout) and break
    // every downstream assumption of a single "current visit" (dashboard,
    // radius-alert staging, geofence monitoring).
    const openVisitResult = await client.query(
      `SELECT cv.id, cv.dealer_id, d.name AS dealer_name
       FROM client_visits cv
       JOIN dealers d ON d.id = cv.dealer_id
       WHERE cv.attendance_id = $1 AND cv.logout_time IS NULL
       LIMIT 1`,
      [attendance_id]
    );
    if (openVisitResult.rows.length > 0) {
      await client.query('ROLLBACK');
      const open = openVisitResult.rows[0];
      return res.status(409).json({
        error: 'visit_already_open',
        visit: { id: open.id, dealer_id: open.dealer_id, dealer_name: open.dealer_name },
      });
    }

    // Verify dealer exists
    const dealerResult = await client.query(
      `SELECT id, name, latitude, longitude, radius_meters FROM dealers WHERE id = $1`,
      [dealer_id]
    );
    if (dealerResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Dealer not found' });
    }
    dealer = dealerResult.rows[0];

    // Geofence check against the dealer's registered coordinates (Haversine).
    // A dealer with no registered coordinates can't be geofenced — treat as inside.
    insideRadius = true;
    distanceM = null;
    if (dealer.latitude != null && dealer.longitude != null) {
      // dealers.radius_meters is NOT NULL DEFAULT 200 (schema.sql) — every
      // row always has a value, so no further fallback is needed here.
      distanceM = haversineKm(parseFloat(dealer.latitude), parseFloat(dealer.longitude), lat, lng) * 1000;
      insideRadius = distanceM <= dealer.radius_meters;
    }

    trimmedReason = typeof reason === 'string' ? reason.trim() : '';
    if (!insideRadius && trimmedReason.length < MIN_REASON_LENGTH) {
      await client.query('ROLLBACK');
      return res.status(422).json({
        error: 'reason_required',
        distanceMeters: distanceM,
        minLength: MIN_REASON_LENGTH,
      });
    }

    // Find the last known location (most recent logout, else day login)
    const lastVisitResult = await client.query(
      `SELECT logout_lat, logout_lng
       FROM client_visits
       WHERE attendance_id = $1 AND logout_time IS NOT NULL
       ORDER BY logout_time DESC
       LIMIT 1`,
      [attendance_id]
    );

    let prevLat, prevLng;
    if (lastVisitResult.rows.length > 0 && lastVisitResult.rows[0].logout_lat != null) {
      prevLat = parseFloat(lastVisitResult.rows[0].logout_lat);
      prevLng = parseFloat(lastVisitResult.rows[0].logout_lng);
    } else {
      prevLat = parseFloat(att.login_lat);
      prevLng = parseFloat(att.login_lng);
    }

    // Road distance for this leg (previous dealer's logout, or the day's
    // login/home point if this is the first dealer today, -> this dealer)
    // via Google Routes API only — no straight-line fallback. A rep's
    // check-in now genuinely depends on Google being reachable; the client
    // shows "Request timed out — Retry" and the idempotency key above makes
    // a retry safe to resend.
    let distFromPrev;
    const distanceIsRouted = true;
    let route;
    try {
      route = await computeRoute({ originLat: prevLat, originLng: prevLng, destLat: lat, destLng: lng });
    } catch (routeErr) {
      logger.warn('Routes API failed for dealer-to-dealer leg', { error: routeErr.message });
      await client.query('ROLLBACK');
      return res.status(502).json({ error: 'route_computation_failed', message: 'Request timed out — Retry' });
    }
    if (route.distanceMeters == null) {
      logger.warn('Routes API returned no distance for dealer-to-dealer leg');
      await client.query('ROLLBACK');
      return res.status(502).json({ error: 'route_computation_failed', message: 'Request timed out — Retry' });
    }
    distFromPrev = route.distanceMeters / 1000;

    // Create visit record
    const visitResult = await client.query(
      `INSERT INTO client_visits
         (attendance_id, dealer_id, login_time, login_lat, login_lng,
          distance_from_previous_km, distance_is_routed, login_accuracy_m, login_distance_m,
          login_inside_radius, login_justification_note, sync_status)
       VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9, $10, 'synced')
       RETURNING id, dealer_id, login_time, login_lat, login_lng, distance_from_previous_km,
                 distance_is_routed, login_distance_m, login_inside_radius`,
      [attendance_id, dealer_id, lat, lng, distFromPrev, distanceIsRouted, accuracyMeters, distanceM, insideRadius, trimmedReason || null]
    );
    visit = visitResult.rows[0];

    // Update attendance total_distance_km
    await client.query(
      `UPDATE attendance
       SET total_distance_km = COALESCE(total_distance_km, 0) + $1
       WHERE id = $2`,
      [distFromPrev, attendance_id]
    );

    if (!insideRadius) {
      await client.query(
        `INSERT INTO exception_log
           (employee_id, dealer_id, visit_id, event_type, latitude, longitude,
            distance_meters, gps_accuracy_m, reason)
         VALUES ($1, $2, $3, 'login', $4, $5, $6, $7, $8)`,
        [employeeId, dealer_id, visit.id, lat, lng, distanceM, accuracyMeters, trimmedReason]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Visit login error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }

  // Side effects that don't need to be part of the transaction above.
  if (!insideRadius) {
    await createManagerNotification({
      type: 'login_exception',
      title: 'Representative login exception',
      body: `${req.employee.username} logged in at ${dealer.name} from outside the dealer radius (~${Math.round(distanceM)}m away). Reason: "${trimmedReason}"`,
      severity: 'warning',
      employeeId,
      dealerId: dealer_id,
      visitId: visit.id,
    });
  }

  logDealerLogin(req.employee.username, dealer.name);
  // Non-blocking: if this dealer happens to be on today's manager-assigned
  // list, mark it visited. Never affects the check-in response either way.
  markAssignmentVisited({ employeeId, dealerId: dealer_id }).catch(() => {});
  const body = {
    visit: {
      ...visit,
      dealer_name: dealer.name,
    },
  };
  await saveIdempotentResponse(idempotencyKey, employeeId, 'visits/login', 201, body);
  return res.status(201).json(body);
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/visits/logout
// ──────────────────────────────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  const { visit_id, reason } = req.body;
  const employeeId = req.employee.id;

  if (!visit_id || req.body.lat === undefined || req.body.lng === undefined) {
    return res.status(400).json({ error: 'visit_id, lat, and lng are required' });
  }
  const lat = parseCoord(req.body.lat, -90, 90);
  const lng = parseCoord(req.body.lng, -180, 180);
  if (lat === null || lng === null) {
    return res.status(400).json({ error: 'lat and lng must be valid numbers (-90..90, -180..180)' });
  }
  const accuracyMeters = parseAccuracy(req.body.accuracy_meters);
  if (accuracyMeters === null) {
    return res.status(400).json({ error: 'accuracy_meters is required' });
  }
  if (accuracyMeters > GPS_ACCURACY_THRESHOLD_M) {
    return res.status(422).json({ error: 'gps_accuracy_exceeded', accuracyMeters, thresholdMeters: GPS_ACCURACY_THRESHOLD_M });
  }

  const idempotencyKey = req.get('Idempotency-Key') || null;

  try {
    const cached = await getIdempotentResponse(idempotencyKey, employeeId, 'visits/logout');
    if (cached) {
      return res.status(cached.response_status).json(cached.response_body);
    }

    // Verify visit belongs to this employee via attendance join, and pull
    // the dealer's registered location + radius for the geofence check below.
    // login_inside_radius decides which of Task 5's logout branches applies:
    // a normal login (true) gets the proactive inside-radius-or-drift-match
    // gate with no override; an exception login (false) always requires a
    // written reason regardless of current distance.
    const visitResult = await pool.query(
      `SELECT cv.id, cv.attendance_id, cv.dealer_id, cv.login_time, cv.logout_time,
              cv.login_lat, cv.login_lng, cv.login_inside_radius,
              d.name AS dealer_name, d.latitude AS dealer_lat, d.longitude AS dealer_lng,
              d.radius_meters AS dealer_radius_meters
       FROM client_visits cv
       JOIN attendance a ON a.id = cv.attendance_id
       JOIN dealers d ON d.id = cv.dealer_id
       WHERE cv.id = $1 AND a.employee_id = $2`,
      [visit_id, employeeId]
    );

    if (visitResult.rows.length === 0) {
      return res.status(404).json({ error: 'Visit record not found' });
    }

    const visit = visitResult.rows[0];
    if (visit.logout_time) {
      // Reconciliation, not a dead end: a retried/offline-queued logout
      // racing a first successful one shouldn't just be dropped by the
      // client — hand back the authoritative record so it can update its
      // local state to match instead of silently discarding the action.
      return res.status(409).json({
        error: 'Visit already logged out',
        visit: {
          id: visit.id,
          logout_time: visit.logout_time,
        },
      });
    }

    // Geofence check against the dealer's registered coordinates (Haversine).
    // A dealer with no registered coordinates can't be geofenced — treat as inside.
    let distanceM = null;
    let insideRadius = true;
    if (visit.dealer_lat != null && visit.dealer_lng != null) {
      distanceM = haversineKm(parseFloat(visit.dealer_lat), parseFloat(visit.dealer_lng), lat, lng) * 1000;
      insideRadius = distanceM <= visit.dealer_radius_meters;
    }

    // Outside the dealer radius — but if the logout GPS is within tolerance
    // of the recorded login GPS, treat it as normal drift at the same spot
    // rather than a real discrepancy (spec 5.2).
    let matchedLogin = false;
    if (!insideRadius && visit.login_lat != null && visit.login_lng != null) {
      const driftM = haversineKm(parseFloat(visit.login_lat), parseFloat(visit.login_lng), lat, lng) * 1000;
      matchedLogin = driftM <= MATCH_TOLERANCE_M;
    }

    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
    const loginWasException = visit.login_inside_radius === false;
    const outsideNow = !insideRadius && !matchedLogin;

    // A written reason (50-500 chars) is required whenever EITHER is true:
    // the login itself already used an exception (regardless of current
    // distance — the rep already isn't in the "normal visit" path), or the
    // rep is currently outside the dealer radius and not drift-matched to
    // the login spot (they're physically leaving from outside, not from the
    // dealer's premises). Inside radius (or drift-matched) with a normal
    // login needs no reason at all.
    if (loginWasException || outsideNow) {
      if (trimmedReason.length < LOGOUT_EXCEPTION_REASON_MIN || trimmedReason.length > LOGOUT_EXCEPTION_REASON_MAX) {
        return res.status(422).json({
          error: 'reason_required',
          distanceMeters: distanceM,
          minLength: LOGOUT_EXCEPTION_REASON_MIN,
          maxLength: LOGOUT_EXCEPTION_REASON_MAX,
        });
      }
    }

    const loginTime  = new Date(visit.login_time);
    const logoutTime = new Date();
    const durationMins = Math.max(0, Math.round((logoutTime - loginTime) / 60000));
    const outOfRadius = !insideRadius;

    const updatedVisit = await pool.query(
      `UPDATE client_visits
       SET logout_time                 = NOW(),
           logout_lat                  = $1,
           logout_lng                  = $2,
           visit_duration_minutes      = $3,
           out_of_radius               = $4,
           logout_accuracy_m           = $5,
           logout_distance_m           = $6,
           matched_login               = $7,
           logout_justification_note   = $8
       WHERE id = $9
       RETURNING id, logout_time, visit_duration_minutes, out_of_radius, matched_login`,
      [lat, lng, durationMins, outOfRadius, accuracyMeters, distanceM, matchedLogin, trimmedReason || null, visit_id]
    );

    // Case 3 — exception at both login and logout — flagged for manager
    // review as "Needs Verification" rather than a plain logout exception.
    const needsVerification = loginWasException && outOfRadius;

    if (outOfRadius) {
      await pool.query(
        `INSERT INTO exception_log
           (employee_id, dealer_id, visit_id, event_type, latitude, longitude,
            distance_meters, gps_accuracy_m, reason, matched_login)
         VALUES ($1, $2, $3, 'logout', $4, $5, $6, $7, $8, $9)`,
        [employeeId, visit.dealer_id, visit_id, lat, lng, distanceM, accuracyMeters, trimmedReason || null, matchedLogin]
      );
      await createManagerNotification({
        type: needsVerification ? 'needs_verification' : 'logout_exception',
        title: needsVerification ? 'Needs Verification' : 'Representative logout exception',
        body: needsVerification
          ? `${req.employee.username} used an exception at BOTH login and logout for ${visit.dealer_name} — please review.`
          : `${req.employee.username} logged out of ${visit.dealer_name} from outside the dealer radius (~${Math.round(distanceM)}m away). Reason: "${trimmedReason}"`,
        severity: 'warning',
        employeeId,
        dealerId: visit.dealer_id,
        visitId: visit_id,
      });
    }

    logDealerLogout(req.employee.username, visit.dealer_name, durationMins, outOfRadius);
    const body = {
      visit: {
        ...updatedVisit.rows[0],
        needs_verification: needsVerification,
      },
    };
    await saveIdempotentResponse(idempotencyKey, employeeId, 'visits/logout', 200, body);
    return res.json(body);
  } catch (err) {
    logger.error('Visit logout error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/visits/:id/location-check — periodic in-visit GPS ping.
// Distinct from /interrupt: this fires on every periodic check regardless of
// inside/outside, so the dashboard can show a live "last checked Xm ago"
// status — not just the one-time consecutive-checks-exceeded flag.
// ──────────────────────────────────────────────────────────────────────────────
router.post('/:id/location-check', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid visit id' });
  }
  const employeeId = req.employee.id;

  const lat = parseCoord(req.body.lat, -90, 90);
  const lng = parseCoord(req.body.lng, -180, 180);
  if (lat === null || lng === null) {
    return res.status(400).json({ error: 'lat and lng must be valid numbers (-90..90, -180..180)' });
  }

  const idempotencyKey = req.get('Idempotency-Key') || null;

  try {
    // Without this, a retried ping would increment outside_radius_count a
    // second time for the same real breach and could double-fire the
    // "time to log out" alert.
    const cached = await getIdempotentResponse(idempotencyKey, employeeId, 'visits/location-check');
    if (cached) {
      return res.status(cached.response_status).json(cached.response_body);
    }

    const visitResult = await pool.query(
      `SELECT cv.id, cv.dealer_id, cv.logout_time, cv.outside_radius_count, cv.log_out_alert_sent,
              d.name AS dealer_name, d.latitude AS dealer_lat, d.longitude AS dealer_lng, d.radius_meters,
              e.name AS employee_name
       FROM client_visits cv
       JOIN attendance a ON a.id = cv.attendance_id
       JOIN dealers d ON d.id = cv.dealer_id
       JOIN employees e ON e.id = a.employee_id
       WHERE cv.id = $1 AND a.employee_id = $2`,
      [id, employeeId]
    );

    if (visitResult.rows.length === 0) {
      return res.status(404).json({ error: 'Visit record not found' });
    }

    const visit = visitResult.rows[0];
    if (visit.logout_time) {
      // Queued/offline ping arriving after logout — nothing meaningful to
      // update on a closed visit, but not an error either.
      return res.json({ visit: { id: visit.id, logout_time: visit.logout_time } });
    }

    // A dealer with no registered coordinates can't be geofenced — treat as inside.
    let distanceM = null;
    let insideRadius = true;
    if (visit.dealer_lat != null && visit.dealer_lng != null) {
      distanceM = haversineKm(parseFloat(visit.dealer_lat), parseFloat(visit.dealer_lng), lat, lng) * 1000;
      insideRadius = distanceM <= visit.radius_meters;
    }

    // The `old` CTE snapshots outside_radius_count/log_out_alert_sent once,
    // atomically with the UPDATE that follows (both run as one statement
    // under the row's write lock) — every derived column is computed from
    // that single consistent snapshot instead of the earlier SELECT above,
    // which could be stale by the time this query runs. This is what makes
    // the increment and the alert-eligibility check race-safe: two
    // near-simultaneous pings (the foreground poll racing the background
    // geofence event) can no longer lose an increment or double-fire the
    // alert the way a read-then-write-back-a-literal would.
    const updated = await pool.query(
      `WITH old AS (
         SELECT outside_radius_count, log_out_alert_sent, interrupted, interrupted_distance_m
         FROM client_visits WHERE id = $3
       )
       UPDATE client_visits cv
       SET last_location_status     = $1::text,
           last_location_check_at   = NOW(),
           last_location_distance_m = $2,
           outside_radius_count     = CASE WHEN $1::text = 'inside' THEN old.outside_radius_count ELSE old.outside_radius_count + 1 END,
           log_out_alert_sent       = old.log_out_alert_sent OR (
             $1::text = 'outside' AND NOT old.log_out_alert_sent AND (old.outside_radius_count + 1) >= 2
           ),
           interrupted              = old.interrupted OR (
             $1::text = 'outside' AND NOT old.log_out_alert_sent AND (old.outside_radius_count + 1) >= 2
           ),
           interrupted_at           = CASE WHEN old.interrupted THEN cv.interrupted_at
                                           WHEN ($1::text = 'outside' AND NOT old.log_out_alert_sent AND (old.outside_radius_count + 1) >= 2) THEN NOW()
                                           ELSE cv.interrupted_at END,
           interrupted_distance_m   = CASE WHEN old.interrupted THEN old.interrupted_distance_m
                                           WHEN ($1::text = 'outside' AND NOT old.log_out_alert_sent AND (old.outside_radius_count + 1) >= 2) THEN $2
                                           ELSE old.interrupted_distance_m END
       FROM old
       WHERE cv.id = $3
       RETURNING cv.id, cv.last_location_status, cv.last_location_check_at, cv.last_location_distance_m,
                 cv.outside_radius_count, cv.log_out_alert_sent, cv.interrupted,
                 (NOT old.log_out_alert_sent AND cv.log_out_alert_sent) AS should_send_logout_alert`,
      [insideRadius ? 'inside' : 'outside', distanceM, id]
    );

    const shouldSendLogoutAlert = updated.rows[0].should_send_logout_alert;

    if (shouldSendLogoutAlert) {
      await pool.query(
        `INSERT INTO exception_log
           (employee_id, dealer_id, visit_id, event_type, latitude, longitude, distance_meters)
         VALUES ($1, $2, $3, 'interrupted', $4, $5, $6)`,
        [employeeId, visit.dealer_id, id, lat, lng, distanceM]
      );
      logVisitInterrupted(req.employee.username, visit.dealer_name, distanceM);
    }

    // Task 4 — staged 10/20/30-min excursion alerts. Runs alongside the
    // untouched outside_radius_count/log_out_alert_sent/interrupted logic
    // above (that mechanism keeps working exactly as before for anything
    // already reading it); this is a separate, additive tracker.
    let repNotification = null;
    const openEventResult = await pool.query(
      `SELECT id, left_at, alert_count, max_distance_m FROM visit_radius_events
       WHERE visit_id = $1 AND returned_at IS NULL`,
      [id]
    );
    const openEvent = openEventResult.rows[0] || null;

    if (!insideRadius) {
      if (!openEvent) {
        // Excursion just started — open the tracker. No alert fires on the
        // very first outside check; the clock starts now.
        try {
          await pool.query(
            `INSERT INTO visit_radius_events (visit_id, employee_id, dealer_id, left_at, alert_count, max_distance_m)
             VALUES ($1, $2, $3, NOW(), 0, $4)`,
            [id, employeeId, visit.dealer_id, distanceM]
          );
        } catch (insertErr) {
          // 23505 = unique_violation on idx_visit_radius_events_open — a
          // concurrent check (visitMonitor's foreground poll racing
          // geofenceTask's background event) already opened one for this
          // visit a moment ago. That one owns the excursion; nothing to do.
          if (insertErr.code !== '23505') throw insertErr;
        }
      } else {
        const minutesOutside = (Date.now() - new Date(openEvent.left_at).getTime()) / 60000;
        const dueStage = Math.floor(minutesOutside / RADIUS_ALERT_STAGE_MINUTES);
        const newMaxDistance = Math.max(openEvent.max_distance_m ?? 0, distanceM ?? 0);
        const stageIsDue = dueStage > openEvent.alert_count;
        const newAlertCount = stageIsDue ? openEvent.alert_count + 1 : openEvent.alert_count;

        // CAS on alert_count (read above, re-checked here): without this,
        // two near-simultaneous pings (the foreground poll racing the
        // background geofence event — the exact scenario the sibling
        // outside_radius_count logic above already guards against) can both
        // read the same alert_count, both decide the same stage is newly
        // due, and both fire the manager/rep notification for it before
        // either has written its own UPDATE. Only the request whose CAS
        // actually lands (rowCount > 0) is the one that "claims" this stage
        // and is allowed to notify; the loser's write silently no-ops and
        // the next poll picks up from the now-current state.
        const claim = await pool.query(
          `UPDATE visit_radius_events SET alert_count = $1, max_distance_m = $2
           WHERE id = $3 AND alert_count = $4`,
          [newAlertCount, newMaxDistance, openEvent.id, openEvent.alert_count]
        );
        const claimed = claim.rowCount > 0;

        if (stageIsDue && claimed) {
          // Fire exactly the next stage, one at a time, even if a long gap
          // between checks means multiple stages became "due" at once —
          // avoids bursting several alerts in one response.
          const stage = newAlertCount;
          const notifyManager = stage === 1 || stage >= 3;
          const notifyRep = stage >= 2;

          if (notifyManager) {
            await createManagerNotification({
              type: stage === 1 ? 'left_dealer' : 'still_outside',
              title: stage === 1 ? 'Representative left dealer' : 'Representative still outside',
              body: stage === 1
                ? `${visit.employee_name} appears to have left ${visit.dealer_name}.`
                : `${visit.employee_name} has been outside ${visit.dealer_name} for ${Math.round(minutesOutside)} minutes.`,
              severity: 'warning',
              employeeId,
              dealerId: visit.dealer_id,
              visitId: id,
            });
          }
          if (notifyRep) {
            repNotification = {
              title: 'Time to log out?',
              body: 'You appear to be outside the dealer location. If your visit has ended please complete Dealer Logout.',
            };
          }
        }
      }
    } else if (openEvent) {
      // Back inside radius — close the excursion. `AND returned_at IS NULL`
      // makes this a claim, not just an update: if two near-simultaneous
      // pings both see the excursion still open, only the one whose UPDATE
      // actually affects a row (rowCount > 0) gets to send the "returned"
      // notification — the loser's write no-ops instead of both firing it.
      // Only notify at all if at least one alert stage actually fired
      // (avoids a notification for a single brief GPS-jitter blip that
      // never reached the 10-minute mark).
      const closed = await pool.query(
        `UPDATE visit_radius_events SET returned_at = NOW() WHERE id = $1 AND returned_at IS NULL`,
        [openEvent.id]
      );
      if (closed.rowCount > 0 && openEvent.alert_count > 0) {
        await createManagerNotification({
          type: 'returned',
          title: 'Representative returned',
          body: `${visit.employee_name} has returned to ${visit.dealer_name}.`,
          severity: 'info',
          employeeId,
          dealerId: visit.dealer_id,
          visitId: id,
        });
        repNotification = {
          title: 'Return inside dealer',
          body: "You're back inside the dealer premises.",
        };
      }
    }

    // eslint-disable-next-line no-unused-vars
    const { should_send_logout_alert, ...visitFields } = updated.rows[0];
    const body = { visit: visitFields, distance_meters: distanceM, rep_notification: repNotification };
    await saveIdempotentResponse(idempotencyKey, employeeId, 'visits/location-check', 200, body);
    return res.json(body);
  } catch (err) {
    logger.error('POST /api/visits/:id/location-check error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/visits — generic list, filterable by date range / dealer / employee.
// Reps see only their own visits; managers may filter by ?employee_id=.
// ──────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { from, to, dealer_id, employee_id } = req.query;
  const isManager = req.employee.role === 'manager';

  try {
    const conditions = [];
    const params = [];

    if (isManager) {
      if (employee_id) {
        const employeeId = parseInt(employee_id);
        if (!Number.isInteger(employeeId)) {
          return res.status(400).json({ error: 'Invalid employee_id' });
        }
        params.push(employeeId);
        conditions.push(`a.employee_id = $${params.length}`);
      }
    } else {
      params.push(req.employee.id);
      conditions.push(`a.employee_id = $${params.length}`);
    }

    if (dealer_id) {
      const dealerId = parseInt(dealer_id);
      if (!Number.isInteger(dealerId)) {
        return res.status(400).json({ error: 'Invalid dealer_id' });
      }
      params.push(dealerId);
      conditions.push(`cv.dealer_id = $${params.length}`);
    }
    // Filtered against the app's business-day boundary (5am IST rollover,
    // see businessDay.js), not the raw UTC calendar date — otherwise a
    // manager filtering by a given date got results that don't match what
    // the app itself considers that business day for any visit near the
    // boundary.
    if (from) {
      params.push(from);
      conditions.push(`${businessDateExpr('cv.login_time')} >= $${params.length}::date`);
    }
    if (to) {
      params.push(to);
      conditions.push(`${businessDateExpr('cv.login_time')} <= $${params.length}::date`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT cv.id, cv.attendance_id, a.employee_id, e.name AS employee_name,
              cv.dealer_id, d.name AS dealer_name, d.address AS dealer_address,
              cv.login_time, cv.login_lat, cv.login_lng, cv.login_inside_radius,
              cv.login_justification_note,
              cv.logout_time, cv.logout_lat, cv.logout_lng, cv.logout_justification_note,
              cv.visit_duration_minutes, cv.distance_from_previous_km, cv.distance_is_routed,
              cv.out_of_radius, cv.interrupted, cv.interrupted_at, cv.sync_status
       FROM client_visits cv
       JOIN attendance a ON a.id = cv.attendance_id
       JOIN dealers d    ON d.id = cv.dealer_id
       JOIN employees e  ON e.id = a.employee_id
       ${whereClause}
       ORDER BY cv.login_time DESC
       LIMIT 1000`,
      params
    );

    // Case 3 (Task 5) — exception used at BOTH login and logout — surfaced
    // as a derived field so the dashboard can show "Needs Verification"
    // without a new persisted column (both source booleans already exist
    // on this row).
    const visits = result.rows.map((v) => ({
      ...v,
      needs_verification: v.login_inside_radius === false && v.out_of_radius === true,
    }));

    return res.json({ visits });
  } catch (err) {
    logger.error('GET /api/visits error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/visits/exceptions — manager-only: out-of-radius login/logout events
// (registered before /:id so "exceptions" is never captured as a visit id)
// ──────────────────────────────────────────────────────────────────────────────
router.get('/exceptions', requireRole('manager'), async (req, res) => {
  const { employee_id, dealer_id, reviewed, from, to } = req.query;

  try {
    const conditions = [];
    const params = [];

    if (employee_id) {
      const employeeId = parseInt(employee_id);
      if (!Number.isInteger(employeeId)) {
        return res.status(400).json({ error: 'Invalid employee_id' });
      }
      params.push(employeeId);
      conditions.push(`el.employee_id = $${params.length}`);
    }
    if (dealer_id) {
      const dealerId = parseInt(dealer_id);
      if (!Number.isInteger(dealerId)) {
        return res.status(400).json({ error: 'Invalid dealer_id' });
      }
      params.push(dealerId);
      conditions.push(`el.dealer_id = $${params.length}`);
    }
    if (reviewed !== undefined) {
      params.push(reviewed === 'true');
      conditions.push(`el.manager_reviewed = $${params.length}`);
    }
    // Business-day boundary (5am IST), not the raw UTC calendar date — see
    // the comment on the /visits list route above for why.
    if (from) {
      params.push(from);
      conditions.push(`${businessDateExpr('el.created_at')} >= $${params.length}::date`);
    }
    if (to) {
      params.push(to);
      conditions.push(`${businessDateExpr('el.created_at')} <= $${params.length}::date`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT el.id, el.employee_id, e.name AS employee_name,
              el.dealer_id, d.name AS dealer_name,
              el.visit_id, el.event_type, el.latitude, el.longitude,
              el.distance_meters, el.gps_accuracy_m, el.reason,
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
       ${whereClause}
       ORDER BY el.created_at DESC
       LIMIT 1000`,
      params
    );

    return res.json({ exceptions: result.rows });
  } catch (err) {
    logger.error('GET /api/visits/exceptions error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// PATCH /api/visits/exceptions/:id — manager-only: mark an exception reviewed
// ──────────────────────────────────────────────────────────────────────────────
router.patch('/exceptions/:id', requireRole('manager'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid exception id' });
  }
  if (req.body.reviewed !== undefined && typeof req.body.reviewed !== 'boolean') {
    return res.status(400).json({ error: 'reviewed must be a boolean' });
  }
  const reviewed = req.body.reviewed !== false;

  try {
    const result = await pool.query(
      `UPDATE exception_log SET manager_reviewed = $1 WHERE id = $2 RETURNING id, manager_reviewed`,
      [reviewed, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Exception record not found' });
    }
    return res.json({ exception: result.rows[0] });
  } catch (err) {
    logger.error('PATCH /api/visits/exceptions/:id error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/visits/:id
// ──────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid visit id' });
  }
  const isManager = req.employee.role === 'manager';

  try {
    const result = await pool.query(
      `SELECT cv.id, cv.attendance_id, a.employee_id, e.name AS employee_name,
              cv.dealer_id, d.name AS dealer_name, d.address AS dealer_address,
              cv.login_time, cv.login_lat, cv.login_lng, cv.login_inside_radius,
              cv.login_justification_note,
              cv.logout_time, cv.logout_lat, cv.logout_lng, cv.logout_justification_note,
              cv.visit_duration_minutes, cv.distance_from_previous_km, cv.distance_is_routed,
              cv.out_of_radius, cv.interrupted, cv.interrupted_at, cv.sync_status
       FROM client_visits cv
       JOIN attendance a ON a.id = cv.attendance_id
       JOIN dealers d    ON d.id = cv.dealer_id
       JOIN employees e  ON e.id = a.employee_id
       WHERE cv.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Visit record not found' });
    }

    const record = result.rows[0];
    if (!isManager && record.employee_id !== req.employee.id) {
      return res.status(403).json({ error: 'Not authorized to view this record' });
    }

    record.needs_verification = record.login_inside_radius === false && record.out_of_radius === true;

    return res.json({ visit: record });
  } catch (err) {
    logger.error('GET /api/visits/:id error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
