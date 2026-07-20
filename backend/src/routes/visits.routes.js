/**
 * visits.routes.js — Stage 5
 *
 * POST /api/visits/check-in  — check in at a dealer
 * POST /api/visits/check-out — check out of a dealer (radius + justification logic)
 */
const express             = require('express');
const pool                = require('../db/pool');
const { haversineKm, isWithinRadius } = require('../utils/haversine');

const router = express.Router();

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/visits/check-in
// ──────────────────────────────────────────────────────────────────────────────
router.post('/check-in', async (req, res) => {
  const { attendance_id, dealer_id, lat, lng } = req.body;
  const employeeId = req.employee.id;

  if (!attendance_id || !dealer_id || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'attendance_id, dealer_id, lat, and lng are required' });
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
          distance_from_previous_km, sync_status)
       VALUES ($1, $2, NOW(), $3, $4, $5, 'synced')
       RETURNING id, dealer_id, check_in_time, check_in_lat, check_in_lng, distance_from_previous_km`,
      [attendance_id, dealer_id, lat, lng, distFromPrev]
    );

    // Update attendance total_distance_km
    await pool.query(
      `UPDATE attendance
       SET total_distance_km = COALESCE(total_distance_km, 0) + $1
       WHERE id = $2`,
      [distFromPrev, attendance_id]
    );

    return res.status(201).json({
      visit: {
        ...visitResult.rows[0],
        dealer_name:   dealer.name,
      },
    });
  } catch (err) {
    console.error('Visit check-in error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /api/visits/check-out
// ──────────────────────────────────────────────────────────────────────────────
router.post('/check-out', async (req, res) => {
  const { visit_id, lat, lng } = req.body;
  const employeeId = req.employee.id;

  if (!visit_id || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'visit_id, lat, and lng are required' });
  }

  try {
    // Verify visit belongs to this employee via attendance join
    const visitResult = await pool.query(
      `SELECT cv.id, cv.attendance_id, cv.check_in_time
       FROM client_visits cv
       JOIN attendance a ON a.id = cv.attendance_id
       WHERE cv.id = $1 AND a.employee_id = $2`,
      [visit_id, employeeId]
    );

    if (visitResult.rows.length === 0) {
      return res.status(404).json({ error: 'Visit record not found' });
    }

    const visit = visitResult.rows[0];

    const checkInTime  = new Date(visit.check_in_time);
    const checkOutTime = new Date();
    const durationMins = Math.round((checkOutTime - checkInTime) / 60000);

    const updatedVisit = await pool.query(
      `UPDATE client_visits
       SET check_out_time          = NOW(),
           check_out_lat           = $1,
           check_out_lng           = $2,
           visit_duration_minutes  = $3
       WHERE id = $4
       RETURNING id, check_out_time, visit_duration_minutes`,
      [lat, lng, durationMins, visit_id]
    );

    return res.json({
      visit: {
        ...updatedVisit.rows[0],
      },
    });
  } catch (err) {
    console.error('Visit check-out error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
