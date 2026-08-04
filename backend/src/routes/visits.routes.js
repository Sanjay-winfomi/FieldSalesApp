/**
 * visits.routes.js — Stage 5 + Dealer Geofencing & GPS Validation spec
 *
 * POST /api/visits/login  — log in at a dealer (blocked outside radius w/o justification)
 * POST /api/visits/logout — log out of a dealer (blocked outside radius w/o justification,
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
const { logDealerLogin, logDealerLogout, logVisitInterrupted } = require('../utils/activityLog');
const { requireRole }     = require('../middleware/auth.middleware');

const router = express.Router();

const GPS_ACCURACY_THRESHOLD_M = parseInt(process.env.GPS_ACCURACY_THRESHOLD_METERS || '30');
const MATCH_TOLERANCE_M         = parseInt(process.env.LOGIN_MATCH_TOLERANCE_METERS || '20');
const SYSTEM_DEFAULT_RADIUS_M   = parseInt(process.env.LOGIN_RADIUS_METERS || '200');
const MIN_REASON_LENGTH         = 20;

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

  try {
    // Verify attendance belongs to this employee
    const attResult = await pool.query(
      `SELECT id, login_lat, login_lng FROM attendance
       WHERE id = $1 AND employee_id = $2`,
      [attendance_id, employeeId]
    );
    if (attResult.rows.length === 0) {
      return res.status(404).json({ error: 'Attendance record not found' });
    }
    const att = attResult.rows[0];

    // Verify dealer exists
    const dealerResult = await pool.query(
      `SELECT id, name, latitude, longitude, radius_meters FROM dealers WHERE id = $1`,
      [dealer_id]
    );
    if (dealerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Dealer not found' });
    }
    const dealer = dealerResult.rows[0];

    // Geofence check against the dealer's registered coordinates (Haversine).
    // A dealer with no registered coordinates can't be geofenced — treat as inside.
    let distanceM = null;
    let insideRadius = true;
    if (dealer.latitude != null && dealer.longitude != null) {
      const radiusMeters = dealer.radius_meters ?? SYSTEM_DEFAULT_RADIUS_M;
      distanceM = haversineKm(parseFloat(dealer.latitude), parseFloat(dealer.longitude), lat, lng) * 1000;
      insideRadius = distanceM <= radiusMeters;
    }

    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
    if (!insideRadius && trimmedReason.length < MIN_REASON_LENGTH) {
      return res.status(422).json({
        error: 'reason_required',
        distanceMeters: distanceM,
        minLength: MIN_REASON_LENGTH,
      });
    }

    // Find the last known location (most recent logout, else day login)
    const lastVisitResult = await pool.query(
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

    const distFromPrev = haversineKm(prevLat, prevLng, lat, lng);

    // Create visit record
    const visitResult = await pool.query(
      `INSERT INTO client_visits
         (attendance_id, dealer_id, login_time, login_lat, login_lng,
          distance_from_previous_km, login_accuracy_m, login_distance_m,
          login_inside_radius, login_justification_note, sync_status)
       VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9, 'synced')
       RETURNING id, dealer_id, login_time, login_lat, login_lng, distance_from_previous_km,
                 login_distance_m, login_inside_radius`,
      [attendance_id, dealer_id, lat, lng, distFromPrev, accuracyMeters, distanceM, insideRadius, trimmedReason || null]
    );
    const visit = visitResult.rows[0];

    // Update attendance total_distance_km
    await pool.query(
      `UPDATE attendance
       SET total_distance_km = COALESCE(total_distance_km, 0) + $1
       WHERE id = $2`,
      [distFromPrev, attendance_id]
    );

    if (!insideRadius) {
      await pool.query(
        `INSERT INTO exception_log
           (employee_id, dealer_id, visit_id, event_type, latitude, longitude,
            distance_meters, gps_accuracy_m, reason)
         VALUES ($1, $2, $3, 'login', $4, $5, $6, $7, $8)`,
        [employeeId, dealer_id, visit.id, lat, lng, distanceM, accuracyMeters, trimmedReason]
      );
    }

    logDealerLogin(req.employee.username, dealer.name);
    return res.status(201).json({
      visit: {
        ...visit,
        dealer_name: dealer.name,
      },
    });
  } catch (err) {
    logger.error('Visit login error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
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

  try {
    // Verify visit belongs to this employee via attendance join, and pull
    // the dealer's registered location + radius for the geofence check below.
    const visitResult = await pool.query(
      `SELECT cv.id, cv.attendance_id, cv.dealer_id, cv.login_time, cv.logout_time,
              cv.login_lat, cv.login_lng,
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
      const radiusMeters = visit.dealer_radius_meters ?? SYSTEM_DEFAULT_RADIUS_M;
      distanceM = haversineKm(parseFloat(visit.dealer_lat), parseFloat(visit.dealer_lng), lat, lng) * 1000;
      insideRadius = distanceM <= radiusMeters;
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
    if (!insideRadius && !matchedLogin && trimmedReason.length < MIN_REASON_LENGTH) {
      return res.status(422).json({
        error: 'reason_required',
        distanceMeters: distanceM,
        minLength: MIN_REASON_LENGTH,
      });
    }

    const loginTime  = new Date(visit.login_time);
    const logoutTime = new Date();
    const durationMins = Math.round((logoutTime - loginTime) / 60000);
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

    if (outOfRadius) {
      await pool.query(
        `INSERT INTO exception_log
           (employee_id, dealer_id, visit_id, event_type, latitude, longitude,
            distance_meters, gps_accuracy_m, reason, matched_login)
         VALUES ($1, $2, $3, 'logout', $4, $5, $6, $7, $8, $9)`,
        [employeeId, visit.dealer_id, visit_id, lat, lng, distanceM, accuracyMeters, trimmedReason || null, matchedLogin]
      );
    }

    logDealerLogout(req.employee.username, visit.dealer_name, durationMins, outOfRadius);
    return res.json({
      visit: {
        ...updatedVisit.rows[0],
      },
    });
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

  try {
    const visitResult = await pool.query(
      `SELECT cv.id, cv.dealer_id, cv.logout_time, cv.outside_radius_count, cv.log_out_alert_sent,
              d.name AS dealer_name, d.latitude AS dealer_lat, d.longitude AS dealer_lng, d.radius_meters
       FROM client_visits cv
       JOIN attendance a ON a.id = cv.attendance_id
       JOIN dealers d ON d.id = cv.dealer_id
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
      const radiusMeters = visit.radius_meters ?? SYSTEM_DEFAULT_RADIUS_M;
      distanceM = haversineKm(parseFloat(visit.dealer_lat), parseFloat(visit.dealer_lng), lat, lng) * 1000;
      insideRadius = distanceM <= radiusMeters;
    }

    const nextOutsideCount = insideRadius ? visit.outside_radius_count : visit.outside_radius_count + 1;
    // Any 2 breaches total during the visit (not necessarily consecutive) —
    // once tripped, stays tripped for the rest of this visit (idempotent).
    const shouldSendLogoutAlert = !visit.log_out_alert_sent && nextOutsideCount >= 2;

    const updated = await pool.query(
      `UPDATE client_visits
       SET last_location_status    = $1,
           last_location_check_at  = NOW(),
           last_location_distance_m = $2,
           outside_radius_count    = $3,
           log_out_alert_sent      = log_out_alert_sent OR $4,
           interrupted             = interrupted OR $4,
           interrupted_at          = CASE WHEN interrupted THEN interrupted_at WHEN $4 THEN NOW() ELSE interrupted_at END,
           interrupted_distance_m  = CASE WHEN interrupted THEN interrupted_distance_m WHEN $4 THEN $2 ELSE interrupted_distance_m END
       WHERE id = $5
       RETURNING id, last_location_status, last_location_check_at, last_location_distance_m, outside_radius_count, log_out_alert_sent, interrupted`,
      [insideRadius ? 'inside' : 'outside', distanceM, nextOutsideCount, shouldSendLogoutAlert, id]
    );

    if (shouldSendLogoutAlert) {
      await pool.query(
        `INSERT INTO exception_log
           (employee_id, dealer_id, visit_id, event_type, latitude, longitude, distance_meters)
         VALUES ($1, $2, $3, 'interrupted', $4, $5, $6)`,
        [employeeId, visit.dealer_id, id, lat, lng, distanceM]
      );
      logVisitInterrupted(req.employee.username, visit.dealer_name, distanceM);
    }

    return res.json({ visit: updated.rows[0], distance_meters: distanceM });
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
    if (from) {
      params.push(from);
      conditions.push(`cv.login_time >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      conditions.push(`cv.login_time <= $${params.length}::date + INTERVAL '1 day'`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT cv.id, cv.attendance_id, a.employee_id, e.name AS employee_name,
              cv.dealer_id, d.name AS dealer_name, d.address AS dealer_address,
              cv.login_time, cv.login_lat, cv.login_lng,
              cv.logout_time, cv.logout_lat, cv.logout_lng,
              cv.visit_duration_minutes, cv.distance_from_previous_km,
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

    return res.json({ visits: result.rows });
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
    if (from) {
      params.push(from);
      conditions.push(`el.created_at >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      conditions.push(`el.created_at <= $${params.length}::date + INTERVAL '1 day'`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT el.id, el.employee_id, e.name AS employee_name,
              el.dealer_id, d.name AS dealer_name,
              el.visit_id, el.event_type, el.latitude, el.longitude,
              el.distance_meters, el.gps_accuracy_m, el.reason,
              el.matched_login, el.manager_reviewed, el.created_at
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
              cv.login_time, cv.login_lat, cv.login_lng,
              cv.logout_time, cv.logout_lat, cv.logout_lng,
              cv.visit_duration_minutes, cv.distance_from_previous_km,
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

    return res.json({ visit: record });
  } catch (err) {
    logger.error('GET /api/visits/:id error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
