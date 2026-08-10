/**
 * attendance.routes.js — Stage 5
 *
 * POST /api/attendance/login   — start the day
 * POST /api/attendance/logout  — end the day
 * GET  /api/attendance/today   — restore state on app reopen
 */
const express = require('express');
const logger = require('../utils/logger');
const pool    = require('../db/pool');
const { logDayLogin, logDayLogout } = require('../utils/activityLog');
const { isCurrentBusinessDay, businessDateExpr } = require('../utils/businessDay');
const { getIdempotentResponse, saveIdempotentResponse } = require('../utils/idempotency');
const { notifyUnvisitedAssignments } = require('../utils/dealerAssignments');

const router = express.Router();

// Coerces lat/lng to finite numbers within valid geographic ranges, or returns
// null. Guards against string/NaN/out-of-range payloads reaching the DB or
// activityLog's `.toFixed()` calls (which throw on non-numbers and would turn
// an already-committed login into a false 500 for the client).
function parseCoord(value, min, max) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/attendance/login
// ──────────────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const employeeId = req.employee.id;

  if (req.body.lat === undefined || req.body.lng === undefined) {
    return res.status(400).json({ error: 'lat and lng are required' });
  }
  const lat = parseCoord(req.body.lat, -90, 90);
  const lng = parseCoord(req.body.lng, -180, 180);
  if (lat === null || lng === null) {
    return res.status(400).json({ error: 'lat and lng must be valid numbers (-90..90, -180..180)' });
  }

  const idempotencyKey = req.get('Idempotency-Key') || null;

  try {
    // A retry of a request that already completed replays the original
    // response instead of re-running the insert below.
    const cached = await getIdempotentResponse(idempotencyKey, employeeId);
    if (cached) {
      return res.status(cached.response_status).json(cached.response_body);
    }

    // Atomic guard against a second login on the same business day: the
    // unique index on (employee_id, business_date) makes two concurrent
    // login requests (double-tap, retry-on-timeout) resolve to exactly one
    // row, instead of a separate SELECT-then-INSERT which leaves a race window.
    const result = await pool.query(
      `INSERT INTO attendance (employee_id, business_date, login_time, login_lat, login_lng, sync_status)
       VALUES ($1, ${businessDateExpr('NOW()')}, NOW(), $2, $3, 'synced')
       ON CONFLICT (employee_id, business_date) WHERE business_date IS NOT NULL DO NOTHING
       RETURNING id, login_time, login_lat, login_lng`,
      [employeeId, lat, lng]
    );

    if (result.rows.length === 0) {
      const existing = await pool.query(
        `SELECT id FROM attendance
         WHERE employee_id = $1 AND business_date = ${businessDateExpr('NOW()')}
         LIMIT 1`,
        [employeeId]
      );
      return res.status(409).json({
        error: 'Already logged in today',
        attendance_id: existing.rows[0]?.id,
      });
    }

    logDayLogin(req.employee.username, lat, lng);
    const body = { attendance: result.rows[0] };
    await saveIdempotentResponse(idempotencyKey, employeeId, 'attendance/login', 201, body);
    return res.status(201).json(body);
  } catch (err) {
    logger.error('Attendance login error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/attendance/logout
// ──────────────────────────────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  const { attendance_id } = req.body;
  const employeeId = req.employee.id;

  if (!attendance_id || req.body.lat === undefined || req.body.lng === undefined) {
    return res.status(400).json({ error: 'attendance_id, lat, and lng are required' });
  }
  const lat = parseCoord(req.body.lat, -90, 90);
  const lng = parseCoord(req.body.lng, -180, 180);
  if (lat === null || lng === null) {
    return res.status(400).json({ error: 'lat and lng must be valid numbers (-90..90, -180..180)' });
  }

  const idempotencyKey = req.get('Idempotency-Key') || null;

  try {
    const cached = await getIdempotentResponse(idempotencyKey, employeeId);
    if (cached) {
      return res.status(cached.response_status).json(cached.response_body);
    }

    const existing = await pool.query(
      `SELECT id, login_time, logout_time, total_distance_km
       FROM attendance
       WHERE id = $1 AND employee_id = $2`,
      [attendance_id, employeeId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Attendance record not found' });
    }

    const att = existing.rows[0];
    if (!att.login_time) {
      return res.status(400).json({ error: 'No login time recorded' });
    }
    if (att.logout_time) {
      // Reconciliation, not a dead end: a retried/offline-queued logout
      // racing an already-succeeded one shouldn't be silently dropped by the
      // client — return the authoritative record so it can adopt server truth.
      return res.status(409).json({
        error: 'Already logged out today',
        attendance: { id: att.id, logout_time: att.logout_time },
      });
    }

    const loginTime  = new Date(att.login_time);
    const logoutTime = new Date();
    const durationMins = Math.round((logoutTime - loginTime) / 60000);

    const result = await pool.query(
      `UPDATE attendance
       SET logout_time = NOW(),
           logout_lat  = $1,
           logout_lng  = $2,
           total_duration_minutes = $3
       WHERE id = $4
       RETURNING id, login_time, logout_time, total_distance_km, total_duration_minutes`,
      [lat, lng, durationMins, attendance_id]
    );

    // Fetch visit summary for the day-end summary screen
    const visitsResult = await pool.query(
      `SELECT COUNT(*) AS visits_count FROM client_visits WHERE attendance_id = $1`,
      [attendance_id]
    );

    logDayLogout(req.employee.username, durationMins, result.rows[0].total_distance_km);
    // Non-blocking: if the rep is ending the day with any assigned dealer
    // still not visited, let the manager know. Never affects the logout
    // response either way.
    notifyUnvisitedAssignments({ employeeId }).catch(() => {});
    const body = {
      attendance: result.rows[0],
      summary: {
        visits_count:       parseInt(visitsResult.rows[0].visits_count),
        total_distance_km:  parseFloat(result.rows[0].total_distance_km || 0),
        total_duration_min: durationMins,
      },
    };
    await saveIdempotentResponse(idempotencyKey, employeeId, 'attendance/logout', 200, body);
    return res.json(body);
  } catch (err) {
    logger.error('Attendance logout error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/attendance/today
// ──────────────────────────────────────────────────────────────────────────────
router.get('/today', async (req, res) => {
  const employeeId = req.employee.id;

  try {
    const attResult = await pool.query(
      `SELECT id, login_time, login_lat, login_lng,
              logout_time, logout_lat, logout_lng,
              total_distance_km, total_duration_minutes, sync_status
       FROM attendance
       WHERE employee_id = $1
         AND ${isCurrentBusinessDay('login_time')}
       LIMIT 1`,
      [employeeId]
    );

    if (attResult.rows.length === 0) {
      return res.json({ attendance: null, visits: [] });
    }

    const att = attResult.rows[0];

    const visitsResult = await pool.query(
      `SELECT cv.id, cv.dealer_id, d.name AS dealer_name, d.address AS dealer_address,
              d.latitude AS dealer_lat, d.longitude AS dealer_lng, d.radius_meters AS dealer_radius_meters,
              cv.login_time, cv.login_lat, cv.login_lng, cv.login_inside_radius, cv.logout_time,
              cv.visit_duration_minutes, cv.distance_from_previous_km,
              cv.out_of_radius, cv.interrupted, cv.interrupted_at,
              cv.login_justification_note, cv.sync_status
       FROM client_visits cv
       JOIN dealers d ON d.id = cv.dealer_id
       WHERE cv.attendance_id = $1
       ORDER BY cv.login_time`,
      [att.id]
    );

    return res.json({ attendance: att, visits: visitsResult.rows });
  } catch (err) {
    logger.error('GET today error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/attendance — generic list, date-range filterable.
// Reps see only their own records; managers may filter by ?employee_id=.
// ──────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { from, to, employee_id } = req.query;
  const isManager = req.employee.role === 'manager';

  try {
    const conditions = [];
    const params = [];

    if (isManager) {
      // Managers see everyone by default, or one rep if employee_id is given.
      if (employee_id) {
        const employeeId = parseInt(employee_id);
        if (!Number.isInteger(employeeId)) {
          return res.status(400).json({ error: 'Invalid employee_id' });
        }
        params.push(employeeId);
        conditions.push(`a.employee_id = $${params.length}`);
      }
    } else {
      // Reps only ever see their own records, regardless of any employee_id param.
      params.push(req.employee.id);
      conditions.push(`a.employee_id = $${params.length}`);
    }

    if (from) {
      params.push(from);
      conditions.push(`a.login_time >= $${params.length}`);
    }
    if (to) {
      params.push(to);
      conditions.push(`a.login_time <= $${params.length}::date + INTERVAL '1 day'`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT a.id, a.employee_id, e.name AS employee_name,
              a.login_time, a.login_lat, a.login_lng,
              a.logout_time, a.logout_lat, a.logout_lng,
              a.total_distance_km, a.total_duration_minutes, a.sync_status
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
       ${whereClause}
       ORDER BY a.login_time DESC
       LIMIT 1000`,
      params
    );

    return res.json({ attendance: result.rows });
  } catch (err) {
    logger.error('GET /api/attendance error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// GET /api/attendance/:id
// ──────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid attendance id' });
  }
  const isManager = req.employee.role === 'manager';

  try {
    const result = await pool.query(
      `SELECT a.id, a.employee_id, e.name AS employee_name,
              a.login_time, a.login_lat, a.login_lng,
              a.logout_time, a.logout_lat, a.logout_lng,
              a.total_distance_km, a.total_duration_minutes, a.sync_status
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
       WHERE a.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Attendance record not found' });
    }

    const record = result.rows[0];
    if (!isManager && record.employee_id !== req.employee.id) {
      return res.status(403).json({ error: 'Not authorized to view this record' });
    }

    return res.json({ attendance: record });
  } catch (err) {
    logger.error('GET /api/attendance/:id error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
