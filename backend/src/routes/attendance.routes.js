/**
 * attendance.routes.js — Stage 5
 *
 * POST /api/attendance/check-in   — start the day
 * POST /api/attendance/check-out  — end the day
 * GET  /api/attendance/today      — restore state on app reopen
 */
const express = require('express');
const pool    = require('../db/pool');

const router = express.Router();

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/attendance/check-in
// ──────────────────────────────────────────────────────────────────────────────
router.post('/check-in', async (req, res) => {
  const { lat, lng } = req.body;
  const employeeId = req.employee.id;

  if (lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'lat and lng are required' });
  }

  try {
    // Prevent a second check-in on the same day
    const existing = await pool.query(
      `SELECT id FROM attendance
       WHERE employee_id = $1
         AND DATE(check_in_time AT TIME ZONE 'Asia/Kolkata') = CURRENT_DATE
       LIMIT 1`,
      [employeeId]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: 'Already checked in today',
        attendance_id: existing.rows[0].id,
      });
    }

    const result = await pool.query(
      `INSERT INTO attendance (employee_id, check_in_time, check_in_lat, check_in_lng, sync_status)
       VALUES ($1, NOW(), $2, $3, 'synced')
       RETURNING id, check_in_time, check_in_lat, check_in_lng`,
      [employeeId, lat, lng]
    );

    return res.status(201).json({ attendance: result.rows[0] });
  } catch (err) {
    console.error('Attendance check-in error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/attendance/check-out
// ──────────────────────────────────────────────────────────────────────────────
router.post('/check-out', async (req, res) => {
  const { attendance_id, lat, lng } = req.body;
  const employeeId = req.employee.id;

  if (!attendance_id || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'attendance_id, lat, and lng are required' });
  }

  try {
    const existing = await pool.query(
      `SELECT id, check_in_time, total_distance_km
       FROM attendance
       WHERE id = $1 AND employee_id = $2`,
      [attendance_id, employeeId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Attendance record not found' });
    }

    const att = existing.rows[0];
    if (!att.check_in_time) {
      return res.status(400).json({ error: 'No check-in time recorded' });
    }

    const checkInTime  = new Date(att.check_in_time);
    const checkOutTime = new Date();
    const durationMins = Math.round((checkOutTime - checkInTime) / 60000);

    const result = await pool.query(
      `UPDATE attendance
       SET check_out_time = NOW(),
           check_out_lat  = $1,
           check_out_lng  = $2,
           total_duration_minutes = $3
       WHERE id = $4
       RETURNING id, check_in_time, check_out_time, total_distance_km, total_duration_minutes`,
      [lat, lng, durationMins, attendance_id]
    );

    // Fetch visit summary for the day-end summary screen
    const visitsResult = await pool.query(
      `SELECT COUNT(*) AS visits_count FROM client_visits WHERE attendance_id = $1`,
      [attendance_id]
    );

    return res.json({
      attendance: result.rows[0],
      summary: {
        visits_count:       parseInt(visitsResult.rows[0].visits_count),
        total_distance_km:  parseFloat(result.rows[0].total_distance_km || 0),
        total_duration_min: durationMins,
      },
    });
  } catch (err) {
    console.error('Attendance check-out error:', err);
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
      `SELECT id, check_in_time, check_in_lat, check_in_lng,
              check_out_time, check_out_lat, check_out_lng,
              total_distance_km, total_duration_minutes, sync_status
       FROM attendance
       WHERE employee_id = $1
         AND DATE(check_in_time AT TIME ZONE 'Asia/Kolkata') = CURRENT_DATE
       LIMIT 1`,
      [employeeId]
    );

    if (attResult.rows.length === 0) {
      return res.json({ attendance: null, visits: [] });
    }

    const att = attResult.rows[0];

    const visitsResult = await pool.query(
      `SELECT cv.id, cv.dealer_id, d.name AS dealer_name, d.address AS dealer_address,
              cv.check_in_time, cv.check_out_time,
              cv.visit_duration_minutes, cv.distance_from_previous_km,
              cv.out_of_radius, cv.justification_note, cv.sync_status
       FROM client_visits cv
       JOIN dealers d ON d.id = cv.dealer_id
       WHERE cv.attendance_id = $1
       ORDER BY cv.check_in_time`,
      [att.id]
    );

    return res.json({ attendance: att, visits: visitsResult.rows });
  } catch (err) {
    console.error('GET today error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
