/**
 * visits.routes.js — Stage 5 + Dealer Geofencing & GPS Validation spec
 *
 * POST /api/visits/check-in  — check in at a dealer (blocked outside radius w/o justification)
 * POST /api/visits/check-out — check out of a dealer (blocked outside radius w/o justification,
 *                               unless the checkout GPS matches the check-in GPS within tolerance)
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
const { logDealerCheckIn, logDealerCheckOut, logVisitInterrupted } = require('../utils/activityLog');
const { requireRole }     = require('../middleware/auth.middleware');

const router = express.Router();

const GPS_ACCURACY_THRESHOLD_M = parseInt(process.env.GPS_ACCURACY_THRESHOLD_METERS || '30');
const MATCH_TOLERANCE_M         = parseInt(process.env.CHECKIN_MATCH_TOLERANCE_METERS || '20');
const SYSTEM_DEFAULT_RADIUS_M   = parseInt(process.env.CHECKIN_RADIUS_METERS || '200');
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
// POST /api/visits/check-in
// ──────────────────────────────────────────────────────────────────────────────
router.post('/check-in', async (req, res) => {
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
      `SELECT id, check_in_lat, check_in_lng FROM attendance
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

    // Find the last known location (most recent check-out, else day check-in)
    const lastVisitResult = await pool.query(
      `SELECT check_out_lat, check_out_lng
       FROM client_visits
       WHERE attendance_id = $1 AND check_out_time IS NOT NULL
       ORDER BY check_out_time DESC
       LIMIT 1`,
      [attendance_id]
    );

    let prevLat, prevLng;
    if (lastVisitResult.rows.length > 0 && lastVisitResult.rows[0].check_out_lat != null) {
      prevLat = parseFloat(lastVisitResult.rows[0].check_out_lat);
      prevLng = parseFloat(lastVisitResult.rows[0].check_out_lng);
    } else {
      prevLat = parseFloat(att.check_in_lat);
      prevLng = parseFloat(att.check_in_lng);
    }

    const distFromPrev = haversineKm(prevLat, prevLng, lat, lng);

    // Create visit record
    const visitResult = await pool.query(
      `INSERT INTO client_visits
         (attendance_id, dealer_id, check_in_time, check_in_lat, check_in_lng,
          distance_from_previous_km, check_in_accuracy_m, check_in_distance_m,
          check_in_inside_radius, justification_note, sync_status)
       VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9, 'synced')
       RETURNING id, dealer_id, check_in_time, check_in_lat, check_in_lng, distance_from_previous_km,
                 check_in_distance_m, check_in_inside_radius`,
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
         VALUES ($1, $2, $3, 'check-in', $4, $5, $6, $7, $8)`,
        [employeeId, dealer_id, visit.id, lat, lng, distanceM, accuracyMeters, trimmedReason]
      );
    }

    logDealerCheckIn(req.employee.username, dealer.name);
    return res.status(201).json({
      visit: {
        ...visit,
        dealer_name: dealer.name,
      },
    });
  } catch (err) {
    logger.error('Visit check-in error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/visits/check-out
// ──────────────────────────────────────────────────────────────────────────────
router.post('/check-out', async (req, res) => {
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
      `SELECT cv.id, cv.attendance_id, cv.dealer_id, cv.check_in_time, cv.check_out_time,
              cv.check_in_lat, cv.check_in_lng,
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
    if (visit.check_out_time) {
      // Reconciliation, not a dead end: a retried/offline-queued check-out
      // racing a first successful one shouldn't just be dropped by the
      // client — hand back the authoritative record so it can update its
      // local state to match instead of silently discarding the action.
      return res.status(409).json({
        error: 'Visit already checked out',
        visit: {
          id: visit.id,
          check_out_time: visit.check_out_time,
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

    // Outside the dealer radius — but if the checkout GPS is within tolerance
    // of the recorded check-in GPS, treat it as normal drift at the same spot
    // rather than a real discrepancy (spec 5.2).
    let matchedCheckIn = false;
    if (!insideRadius && visit.check_in_lat != null && visit.check_in_lng != null) {
      const driftM = haversineKm(parseFloat(visit.check_in_lat), parseFloat(visit.check_in_lng), lat, lng) * 1000;
      matchedCheckIn = driftM <= MATCH_TOLERANCE_M;
    }

    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
    if (!insideRadius && !matchedCheckIn && trimmedReason.length < MIN_REASON_LENGTH) {
      return res.status(422).json({
        error: 'reason_required',
        distanceMeters: distanceM,
        minLength: MIN_REASON_LENGTH,
      });
    }

    const checkInTime  = new Date(visit.check_in_time);
    const checkOutTime = new Date();
    const durationMins = Math.round((checkOutTime - checkInTime) / 60000);
    const outOfRadius = !insideRadius;

    const updatedVisit = await pool.query(
      `UPDATE client_visits
       SET check_out_time              = NOW(),
           check_out_lat               = $1,
           check_out_lng               = $2,
           visit_duration_minutes      = $3,
           out_of_radius               = $4,
           check_out_accuracy_m        = $5,
           check_out_distance_m        = $6,
           matched_check_in            = $7,
           check_out_justification_note = $8
       WHERE id = $9
       RETURNING id, check_out_time, visit_duration_minutes, out_of_radius, matched_check_in`,
      [lat, lng, durationMins, outOfRadius, accuracyMeters, distanceM, matchedCheckIn, trimmedReason || null, visit_id]
    );

    if (outOfRadius) {
      await pool.query(
        `INSERT INTO exception_log
           (employee_id, dealer_id, visit_id, event_type, latitude, longitude,
            distance_meters, gps_accuracy_m, reason, matched_check_in)
         VALUES ($1, $2, $3, 'check-out', $4, $5, $6, $7, $8, $9)`,
        [employeeId, visit.dealer_id, visit_id, lat, lng, distanceM, accuracyMeters, trimmedReason || null, matchedCheckIn]
      );
    }

    logDealerCheckOut(req.employee.username, visit.dealer_name, durationMins, outOfRadius);
    return res.json({
      visit: {
        ...updatedVisit.rows[0],
      },
    });
  } catch (err) {
    logger.error('Visit check-out error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/visits/:id/interrupt — Random Location Verification spec.
// The rep's own device reports that periodic in-visit GPS checks found them
// outside the dealer's radius for longer than the client's grace period.
// System-detected, so no justification reason is collected (unlike
// check-in/check-out exceptions, which require one) — a manager reviews it
// after the fact via the same exceptions list.
// ──────────────────────────────────────────────────────────────────────────────
router.post('/:id/interrupt', async (req, res) => {
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
  const distanceMeters = typeof req.body.distance_meters === 'number' ? req.body.distance_meters : null;

  try {
    const visitResult = await pool.query(
      `SELECT cv.id, cv.dealer_id, cv.check_out_time, cv.interrupted, d.name AS dealer_name
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
    if (visit.check_out_time) {
      // The rep already checked out (e.g. this report was queued offline and
      // is only syncing now) — nothing meaningful to flag on a closed visit.
      return res.status(409).json({ error: 'Visit already checked out' });
    }
    if (visit.interrupted) {
      // Already flagged earlier in this same visit — idempotent no-op so a
      // retried/offline-queued report doesn't create duplicate exception rows.
      return res.json({ visit: { id: visit.id, interrupted: true } });
    }

    const updated = await pool.query(
      `UPDATE client_visits
       SET interrupted = TRUE, interrupted_at = NOW(), interrupted_distance_m = $1
       WHERE id = $2
       RETURNING id, interrupted, interrupted_at`,
      [distanceMeters, id]
    );

    await pool.query(
      `INSERT INTO exception_log
         (employee_id, dealer_id, visit_id, event_type, latitude, longitude, distance_meters)
       VALUES ($1, $2, $3, 'interrupted', $4, $5, $6)`,
      [employeeId, visit.dealer_id, id, lat, lng, distanceMeters]
    );

    logVisitInterrupted(req.employee.username, visit.dealer_name, distanceMeters);
    return res.json({ visit: updated.rows[0] });
  } catch (err) {
    logger.error('POST /api/visits/:id/interrupt error', { error: err.message, stack: err.stack });
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
      `SELECT cv.id, cv.dealer_id, cv.check_out_time, cv.outside_radius_count, cv.log_out_alert_sent,
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
    if (visit.check_out_time) {
      // Queued/offline ping arriving after checkout — nothing meaningful to
      // update on a closed visit, but not an error either.
      return res.json({ visit: { id: visit.id, check_out_time: visit.check_out_time } });
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
        params.push(parseInt(employee_id));
        conditions.push(`a.employee_id = $${params.length}`);
      }
    } else {
      params.push(req.employee.id);
      conditions.push(`a.employee_id = $${params.length}`);
    }

    if (dealer_id) {
      params.push(parseInt(dealer_id));
      conditions.push(`cv.dealer_id = $${params.length}`);
    }
    if (from) {
      params.push(from);
      conditions.push(`cv.check_in_time >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      conditions.push(`cv.check_in_time <= $${params.length}::date + INTERVAL '1 day'`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT cv.id, cv.attendance_id, a.employee_id, e.name AS employee_name,
              cv.dealer_id, d.name AS dealer_name, d.address AS dealer_address,
              cv.check_in_time, cv.check_in_lat, cv.check_in_lng,
              cv.check_out_time, cv.check_out_lat, cv.check_out_lng,
              cv.visit_duration_minutes, cv.distance_from_previous_km,
              cv.out_of_radius, cv.interrupted, cv.interrupted_at, cv.sync_status
       FROM client_visits cv
       JOIN attendance a ON a.id = cv.attendance_id
       JOIN dealers d    ON d.id = cv.dealer_id
       JOIN employees e  ON e.id = a.employee_id
       ${whereClause}
       ORDER BY cv.check_in_time DESC
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
// GET /api/visits/exceptions — manager-only: out-of-radius check-in/check-out events
// (registered before /:id so "exceptions" is never captured as a visit id)
// ──────────────────────────────────────────────────────────────────────────────
router.get('/exceptions', requireRole('manager'), async (req, res) => {
  const { employee_id, dealer_id, reviewed, from, to } = req.query;

  try {
    const conditions = [];
    const params = [];

    if (employee_id) {
      params.push(parseInt(employee_id));
      conditions.push(`el.employee_id = $${params.length}`);
    }
    if (dealer_id) {
      params.push(parseInt(dealer_id));
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
              el.matched_check_in, el.manager_reviewed, el.created_at
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
              cv.check_in_time, cv.check_in_lat, cv.check_in_lng,
              cv.check_out_time, cv.check_out_lat, cv.check_out_lng,
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
