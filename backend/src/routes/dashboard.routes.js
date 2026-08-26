/**
 * dashboard.routes.js — Stage 10
 *
 * GET /api/dashboard/today — manager-only: all reps' current status for today
 */
const express = require('express');
const logger = require('../utils/logger');
const pool    = require('../db/pool');
const { isCurrentBusinessDay, businessDateExpr } = require('../utils/businessDay');

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
        a.login_time,
        a.logout_time,
        a.total_distance_km,
        a.work_mode,
        a.sync_status   AS day_sync_status,
        -- Latest visit
        lv.dealer_name,
        lv.login_time  AS visit_login,
        lv.logout_time AS visit_logout,
        lv.login_lat   AS last_lat,
        lv.login_lng   AS last_lng,
        -- "Time to log out" alert: the rep's current open visit has hit 2+
        -- cumulative out-of-radius checks and hasn't been logged out of yet.
        (lv.logout_time IS NULL AND lv.log_out_alert_sent) AS needs_logout_alert,
        -- Visit count today
        (SELECT COUNT(*) FROM client_visits cv2 WHERE cv2.attendance_id = a.id) AS visits_count
      FROM employees e
      LEFT JOIN attendance a
        ON a.employee_id = e.id
        AND ${isCurrentBusinessDay('a.login_time')}
      LEFT JOIN LATERAL (
        SELECT cv.login_time, cv.logout_time, cv.login_lat, cv.login_lng,
               cv.log_out_alert_sent, d.name AS dealer_name
        FROM client_visits cv
        JOIN dealers d ON d.id = cv.dealer_id
        WHERE cv.attendance_id = a.id
        ORDER BY cv.login_time DESC
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
        status       = 'not_logged_in';
        lastActivity = 'Not logged in yet';
        timestamp    = null;
      } else if (row.logout_time) {
        status       = 'day_ended';
        // Without an explicit timeZone, this renders in whatever timezone the
        // server process runs in (UTC on Render) rather than IST — 'en-IN'
        // only controls formatting style (AM/PM), not the timezone offset.
        lastActivity = `Office logout, ${new Date(row.logout_time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}`;
        timestamp    = row.logout_time;
      } else if (row.visit_login && !row.visit_logout) {
        status       = 'logged_in';
        lastActivity = `At ${row.dealer_name}`;
        timestamp    = row.visit_login;
      } else if (row.dealer_name) {
        status       = 'logged_in';
        lastActivity = `Travelling from ${row.dealer_name}`;
        timestamp    = row.visit_logout;
      } else if (row.work_mode === 'office') {
        // Still counts toward the "Logged in" stat (status stays the same
        // as the branch below) — only the label differs, so an office day
        // doesn't misleadingly read as "hasn't started visiting dealers yet".
        status       = 'logged_in';
        lastActivity = 'At office today';
        timestamp    = row.login_time;
      } else {
        status       = 'logged_in';
        lastActivity = 'Logged in — no visits yet';
        timestamp    = row.login_time;
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
      `SELECT id, login_time, login_lat, login_lng,
              logout_time, logout_lat, logout_lng,
              total_distance_km, total_duration_minutes, work_mode, sync_status
       FROM attendance
       WHERE employee_id = $1
         AND ${isCurrentBusinessDay('login_time')}
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
              cv.login_time, cv.login_lat, cv.login_lng,
              cv.logout_time, cv.logout_lat, cv.logout_lng,
              cv.visit_duration_minutes, cv.distance_from_previous_km,
              cv.login_distance_m, cv.login_inside_radius,
              cv.login_justification_note, cv.logout_justification_note,
              cv.last_location_status, cv.last_location_check_at, cv.last_location_distance_m,
              cv.outside_radius_count, cv.log_out_alert_sent, cv.interrupted, cv.interrupted_at,
              cv.sync_status, vre.left_at AS radius_left_at
       FROM client_visits cv
       JOIN dealers d ON d.id = cv.dealer_id
       -- The currently-open excursion (if any) — at most one per visit
       -- (idx_visit_radius_events_open). Its left_at drives the "outside
       -- the radius N min ago" wording below instead of a static message
       -- that used to keep showing even after the rep came back inside.
       LEFT JOIN visit_radius_events vre ON vre.visit_id = cv.id AND vre.returned_at IS NULL
       WHERE cv.attendance_id = $1
       ORDER BY cv.login_time DESC`,
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

// GET /api/dashboard/map — dealer + rep locations for the manager map view.
// Dealers: latest visit (rep + timestamp), if any. Reps: last known location
// (their latest visit today, falling back to today's login point) plus their
// next pending/navigating assignment for today, if any.
router.get('/map', async (req, res) => {
  try {
    const [dealersResult, repsResult] = await Promise.all([
      pool.query(`
        SELECT
          d.id, d.name, d.address, d.latitude, d.longitude,
          lv.login_time  AS last_visit_time,
          lv.logout_time AS last_visit_logout_time,
          lv.rep_name    AS last_visit_rep_name
        FROM dealers d
        LEFT JOIN LATERAL (
          SELECT cv.login_time, cv.logout_time, e.name AS rep_name
          FROM client_visits cv
          JOIN attendance a ON a.id = cv.attendance_id
          JOIN employees e  ON e.id = a.employee_id
          WHERE cv.dealer_id = d.id
          ORDER BY cv.login_time DESC
          LIMIT 1
        ) lv ON true
        WHERE d.latitude IS NOT NULL AND d.longitude IS NOT NULL
        ORDER BY d.name
      `),
      pool.query(`
        SELECT
          e.id AS employee_id, e.name, e.region,
          a.id AS attendance_id, a.login_lat, a.login_lng,
          lv.dealer_name  AS last_dealer_name,
          lv.login_time   AS last_visit_time,
          lv.login_lat    AS last_lat,
          lv.login_lng    AS last_lng,
          na.dealer_name  AS next_dealer_name,
          na.dealer_lat   AS next_dealer_lat,
          na.dealer_lng   AS next_dealer_lng,
          na.sequence_order AS next_sequence_order
        FROM employees e
        LEFT JOIN attendance a
          ON a.employee_id = e.id
          AND ${isCurrentBusinessDay('a.login_time')}
        LEFT JOIN LATERAL (
          SELECT cv.login_time, cv.login_lat, cv.login_lng, d.name AS dealer_name
          FROM client_visits cv
          JOIN dealers d ON d.id = cv.dealer_id
          WHERE cv.attendance_id = a.id
          ORDER BY cv.login_time DESC
          LIMIT 1
        ) lv ON true
        LEFT JOIN LATERAL (
          SELECT d.name AS dealer_name, d.latitude AS dealer_lat, d.longitude AS dealer_lng,
                 da.sequence_order
          FROM dealer_assignments da
          JOIN dealers d ON d.id = da.dealer_id
          WHERE da.employee_id = e.id
            AND da.assignment_date = ${businessDateExpr('NOW()')}
            AND da.status IN ('pending', 'navigating')
          ORDER BY da.sequence_order ASC
          LIMIT 1
        ) na ON true
        WHERE e.role = 'rep'
        ORDER BY e.name
      `),
    ]);

    const dealers = dealersResult.rows.map((row) => ({
      id:                     row.id,
      name:                   row.name,
      address:                row.address,
      latitude:               parseFloat(row.latitude),
      longitude:              parseFloat(row.longitude),
      last_visit: row.last_visit_time ? {
        rep_name:    row.last_visit_rep_name,
        login_time:  row.last_visit_time,
        logout_time: row.last_visit_logout_time,
      } : null,
    }));

    const reps = repsResult.rows
      .map((row) => {
        const lat = row.last_lat ?? row.login_lat;
        const lng = row.last_lng ?? row.login_lng;
        return {
          id:      row.employee_id,
          name:    row.name,
          region:  row.region,
          latitude:  lat ? parseFloat(lat) : null,
          longitude: lng ? parseFloat(lng) : null,
          last_dealer: row.last_dealer_name ? {
            name:       row.last_dealer_name,
            visit_time: row.last_visit_time,
          } : null,
          next_assignment: row.next_dealer_name ? {
            dealer_name: row.next_dealer_name,
            latitude:    parseFloat(row.next_dealer_lat),
            longitude:   parseFloat(row.next_dealer_lng),
          } : null,
        };
      })
      .filter((rep) => rep.latitude !== null && rep.longitude !== null);

    return res.json({ dealers, reps, generated_at: new Date().toISOString() });
  } catch (err) {
    logger.error('Dashboard map error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
