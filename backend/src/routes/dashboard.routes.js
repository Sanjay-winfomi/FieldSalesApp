/**
 * dashboard.routes.js — Stage 10
 *
 * GET /api/dashboard/today           — manager-only: all reps' current status for today
 * GET /api/dashboard/live-locations  — manager-only: reps' latest known GPS position, for the
 *                                       Representative Heat Map feature
 */
const express = require('express');
const logger = require('../utils/logger');
const pool    = require('../db/pool');
const { isCurrentBusinessDay } = require('../utils/businessDay');

const router = express.Router();

// GET /api/dashboard/today
router.get('/today', async (req, res) => {
  try {
    // Get all reps + their attendance/visit status for today
    const result = await pool.query(`
      SELECT
        e.id            AS employee_id,
        e.name,
        e.region,
        a.id            AS attendance_id,
        a.check_in_time,
        a.check_out_time,
        a.total_distance_km,
        a.sync_status   AS day_sync_status,
        -- Latest visit
        lv.dealer_name,
        lv.check_in_time  AS visit_check_in,
        lv.check_out_time AS visit_check_out,
        lv.check_in_lat   AS last_lat,
        lv.check_in_lng   AS last_lng,
        -- "Time to log out" alert: the rep's current open visit has hit 2+
        -- cumulative out-of-radius checks and hasn't been checked out of yet.
        (lv.check_out_time IS NULL AND lv.log_out_alert_sent) AS needs_logout_alert,
        -- Visit count today
        (SELECT COUNT(*) FROM client_visits cv2 WHERE cv2.attendance_id = a.id) AS visits_count
      FROM employees e
      LEFT JOIN attendance a
        ON a.employee_id = e.id
        AND ${isCurrentBusinessDay('a.check_in_time')}
      LEFT JOIN LATERAL (
        SELECT cv.check_in_time, cv.check_out_time, cv.check_in_lat, cv.check_in_lng,
               cv.log_out_alert_sent, d.name AS dealer_name
        FROM client_visits cv
        JOIN dealers d ON d.id = cv.dealer_id
        WHERE cv.attendance_id = a.id
        ORDER BY cv.check_in_time DESC
        LIMIT 1
      ) lv ON true
      WHERE e.role = 'rep'
      ORDER BY e.name
    `);

    const reps = result.rows.map((row) => {
      let status;
      let lastActivity;
      let timestamp;

      if (!row.attendance_id) {
        status       = 'not_checked_in';
        lastActivity = 'Not checked in yet';
        timestamp    = null;
      } else if (row.check_out_time) {
        status       = 'day_ended';
        lastActivity = `Office check-out, ${new Date(row.check_out_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
        timestamp    = row.check_out_time;
      } else if (row.visit_check_in && !row.visit_check_out) {
        status       = 'checked_in';
        lastActivity = `At ${row.dealer_name}`;
        timestamp    = row.visit_check_in;
      } else if (row.dealer_name) {
        status       = 'checked_in';
        lastActivity = `Travelling from ${row.dealer_name}`;
        timestamp    = row.visit_check_out;
      } else {
        status       = 'checked_in';
        lastActivity = 'Checked in — no visits yet';
        timestamp    = row.check_in_time;
      }

      return {
        id:                 row.employee_id,
        name:               row.name,
        region:             row.region,
        status,
        last_activity:      lastActivity,
        last_updated:       timestamp,
        visits_count:       parseInt(row.visits_count || 0),
        total_distance_km:  parseFloat(row.total_distance_km || 0),
        last_lat:           row.last_lat ? parseFloat(row.last_lat) : null,
        last_lng:           row.last_lng ? parseFloat(row.last_lng) : null,
        day_sync_status:    row.day_sync_status || 'pending',
        needs_logout_alert: row.needs_logout_alert === true,
      };
    });

    return res.json({ reps, generated_at: new Date().toISOString() });
  } catch (err) {
    logger.error('Dashboard error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/dashboard/rep/:id/today
router.get('/rep/:id/today', async (req, res) => {
  const repId = parseInt(req.params.id);
  if (!Number.isInteger(repId)) {
    return res.status(400).json({ error: 'Invalid rep id' });
  }

  try {
    // 1. Fetch representative info
    const empResult = await pool.query(
      'SELECT id, name, phone, username, region FROM employees WHERE id = $1 AND role = \'rep\'',
      [repId]
    );

    if (empResult.rows.length === 0) {
      return res.status(404).json({ error: 'Representative not found' });
    }

    const employee = empResult.rows[0];

    // 2. Fetch today's attendance
    const attResult = await pool.query(
      `SELECT id, check_in_time, check_in_lat, check_in_lng,
              check_out_time, check_out_lat, check_out_lng,
              total_distance_km, total_duration_minutes, sync_status
       FROM attendance
       WHERE employee_id = $1
         AND ${isCurrentBusinessDay('check_in_time')}
       LIMIT 1`,
      [repId]
    );

    if (attResult.rows.length === 0) {
      return res.json({ employee, attendance: null, visits: [] });
    }

    const attendance = attResult.rows[0];

    // 3. Fetch visits for today
    const visitsResult = await pool.query(
      `SELECT cv.id, cv.dealer_id, d.name AS dealer_name, d.address AS dealer_address,
              d.latitude AS dealer_lat, d.longitude AS dealer_lng, d.radius_meters,
              cv.check_in_time, cv.check_in_lat, cv.check_in_lng,
              cv.check_out_time, cv.check_out_lat, cv.check_out_lng,
              cv.visit_duration_minutes, cv.distance_from_previous_km,
              cv.check_in_distance_m, cv.check_in_inside_radius,
              cv.justification_note, cv.check_out_justification_note,
              cv.last_location_status, cv.last_location_check_at, cv.last_location_distance_m,
              cv.outside_radius_count, cv.log_out_alert_sent, cv.interrupted, cv.interrupted_at,
              cv.sync_status
       FROM client_visits cv
       JOIN dealers d ON d.id = cv.dealer_id
       WHERE cv.attendance_id = $1
       ORDER BY cv.check_in_time DESC`,
      [attendance.id]
    );

    return res.json({
      employee,
      attendance,
      visits: visitsResult.rows
    });
  } catch (err) {
    logger.error('Fetch rep details error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
