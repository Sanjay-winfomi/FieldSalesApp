/**
 * navigation.routes.js — Google Routes API (Compute Routes Pro)-backed
 * "Tap Navigate" flow, plus the resulting navigation lifecycle/history.
 *
 * POST  /api/navigation/compute          — rep: fetch a route to a dealer,
 *                                            persists a dealer_navigations row
 *                                            and advances the assignment's status
 * POST  /api/navigation/distance-preview — any authenticated employee: a
 *                                            read-only driving distance/duration
 *                                            between two points, no DB writes at
 *                                            all — for showing a real distance
 *                                            estimate (Visit Plan builder, an
 *                                            assigned-dealer card) WITHOUT
 *                                            implying an actual navigation
 *                                            attempt started
 * PATCH /api/navigation/:id/status    — rep: update the navigation's lifecycle status
 * GET   /api/navigation/history       — manager-only: paginated navigation history
 * GET   /api/navigation/summary/today — rep: today's Daily Travel Summary
 *
 * Never calls Route Optimization / Fleet Routing — always a single
 * origin -> destination pair, matching the fixed assignment sequence.
 */
const express = require('express');
const logger = require('../utils/logger');
const pool = require('../db/pool');
const { requireRole } = require('../middleware/auth.middleware');
const { businessDateExpr } = require('../utils/businessDay');
const { computeRoute } = require('../services/googleRoutesService');

const router = express.Router();

const STATUSES = ['navigating', 'arrived', 'completed', 'cancelled'];

function parseCoord(value, min, max) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

// POST /api/navigation/compute  { dealer_id, assignment_id?, origin_lat, origin_lng }
router.post('/compute', async (req, res) => {
  const dealerId = parseInt(req.body.dealer_id);
  if (!Number.isInteger(dealerId)) {
    return res.status(400).json({ error: 'dealer_id is required' });
  }
  const assignmentId = req.body.assignment_id != null ? parseInt(req.body.assignment_id) : null;
  if (req.body.assignment_id != null && !Number.isInteger(assignmentId)) {
    return res.status(400).json({ error: 'Invalid assignment_id' });
  }
  const originLat = parseCoord(req.body.origin_lat, -90, 90);
  const originLng = parseCoord(req.body.origin_lng, -180, 180);
  if (originLat === null || originLng === null) {
    return res.status(400).json({ error: 'origin_lat and origin_lng must be valid numbers' });
  }

  const employeeId = req.employee.id;

  try {
    const dealerResult = await pool.query(
      'SELECT id, name, latitude, longitude FROM dealers WHERE id = $1',
      [dealerId]
    );
    if (dealerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Dealer not found' });
    }
    const dealer = dealerResult.rows[0];
    if (dealer.latitude == null || dealer.longitude == null) {
      return res.status(422).json({ error: 'dealer_missing_coordinates' });
    }

    if (assignmentId != null) {
      const assignmentResult = await pool.query(
        'SELECT id FROM dealer_assignments WHERE id = $1 AND employee_id = $2',
        [assignmentId, employeeId]
      );
      if (assignmentResult.rows.length === 0) {
        return res.status(404).json({ error: 'Assignment not found' });
      }
    }

    let route;
    try {
      route = await computeRoute({
        originLat,
        originLng,
        destLat: parseFloat(dealer.latitude),
        destLng: parseFloat(dealer.longitude),
      });
    } catch (err) {
      logger.error('Routes API compute error', { error: err.message, dealerId, employeeId });
      return res.status(502).json({ error: 'Could not compute a route right now — please retry.' });
    }

    const navResult = await pool.query(
      `INSERT INTO dealer_navigations
         (assignment_id, employee_id, dealer_id, status, origin_latitude, origin_longitude,
          distance_meters, duration_seconds, duration_in_traffic_seconds, expected_arrival_time, encoded_polyline)
       VALUES ($1, $2, $3, 'navigating', $4, $5, $6, $7, $8, NOW() + ($9 || ' seconds')::interval, $10)
       RETURNING id, status, distance_meters, duration_seconds, duration_in_traffic_seconds,
                 expected_arrival_time, encoded_polyline, started_at`,
      [
        assignmentId, employeeId, dealerId, originLat, originLng,
        route.distanceMeters, route.durationSeconds, route.durationInTrafficSeconds,
        route.durationInTrafficSeconds ?? route.durationSeconds ?? 0, route.encodedPolyline,
      ]
    );

    if (assignmentId != null) {
      await pool.query(
        `UPDATE dealer_assignments SET status = 'navigating', updated_at = NOW() WHERE id = $1`,
        [assignmentId]
      );
    }

    return res.status(201).json({ navigation: navResult.rows[0] });
  } catch (err) {
    logger.error('POST /api/navigation/compute error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/navigation/distance-preview  { origin_lat, origin_lng, dest_lat, dest_lng }
// Read-only: a real Google-Maps driving distance/duration between two
// points, with NOTHING persisted — no dealer_navigations row, no
// assignment status change. Distinct from /compute (which IS "the rep
// tapped Navigate" and behaves accordingly) — this is just "show me a real
// number," usable from a manager's Visit Plan builder (dealer-to-dealer) or
// a rep's assigned-dealer card (rep's current GPS-to-dealer) without either
// implying a navigation attempt actually started.
router.post('/distance-preview', async (req, res) => {
  const originLat = parseCoord(req.body.origin_lat, -90, 90);
  const originLng = parseCoord(req.body.origin_lng, -180, 180);
  const destLat = parseCoord(req.body.dest_lat, -90, 90);
  const destLng = parseCoord(req.body.dest_lng, -180, 180);
  if (originLat === null || originLng === null || destLat === null || destLng === null) {
    return res.status(400).json({ error: 'origin_lat, origin_lng, dest_lat, and dest_lng must be valid numbers' });
  }

  try {
    const route = await computeRoute({ originLat, originLng, destLat, destLng });
    return res.json({
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      durationInTrafficSeconds: route.durationInTrafficSeconds,
    });
  } catch (err) {
    logger.error('POST /api/navigation/distance-preview error', { error: err.message });
    return res.status(502).json({ error: 'Could not compute a distance right now — please retry.' });
  }
});

// PATCH /api/navigation/:id/status  { status }
router.patch('/:id/status', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid navigation id' });
  }
  const { status } = req.body;
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }

  try {
    const existing = await pool.query(
      'SELECT id, employee_id, assignment_id FROM dealer_navigations WHERE id = $1',
      [id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Navigation not found' });
    }
    if (existing.rows[0].employee_id !== req.employee.id) {
      return res.status(403).json({ error: 'Not authorized to update this navigation' });
    }

    const isTerminal = status === 'completed' || status === 'cancelled';
    const result = await pool.query(
      `UPDATE dealer_navigations
       SET status = $1, ended_at = CASE WHEN $2 THEN NOW() ELSE ended_at END
       WHERE id = $3
       RETURNING id, status, ended_at`,
      [status, isTerminal, id]
    );

    const assignmentId = existing.rows[0].assignment_id;
    if (assignmentId != null && status !== 'cancelled') {
      // 'arrived'/'completed' map directly; a cancelled navigation attempt
      // doesn't mean the visit itself is cancelled, so the assignment is
      // left as-is rather than mirrored to 'cancelled'. The rank comparison
      // guards against regressing an assignment backward: a rep can have
      // multiple navigation attempts for one assignment (re-tapping
      // Navigate creates a new dealer_navigations row each time), so a
      // late/out-of-order status update from an earlier, abandoned attempt
      // (e.g. a stale 'arrived' landing after the dealer check-in already
      // advanced this assignment to 'completed') must not downgrade it.
      // status != 'cancelled' is its own explicit condition (not folded into
      // the rank CASE) — 'cancelled' would otherwise share rank 0 with
      // 'pending' in the ELSE branch, letting this same late/stale update
      // resurrect an assignment a manager had deliberately cancelled.
      await pool.query(
        `UPDATE dealer_assignments
         SET status = $1, updated_at = NOW()
         WHERE id = $2
           AND status != 'cancelled'
           AND (CASE status WHEN 'completed' THEN 3 WHEN 'arrived' THEN 2 WHEN 'navigating' THEN 1 ELSE 0 END)
             < (CASE $1     WHEN 'completed' THEN 3 WHEN 'arrived' THEN 2 WHEN 'navigating' THEN 1 ELSE 0 END)`,
        [status, assignmentId]
      );
    }

    return res.json({ navigation: result.rows[0] });
  } catch (err) {
    logger.error('PATCH /api/navigation/:id/status error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/navigation/history?employee_id=&date=&page=&limit=
router.get('/history', requireRole('manager'), async (req, res) => {
  const employeeId = req.query.employee_id ? parseInt(req.query.employee_id) : null;
  if (req.query.employee_id && !Number.isInteger(employeeId)) {
    return res.status(400).json({ error: 'Invalid employee_id' });
  }
  const date = req.query.date && !Number.isNaN(Date.parse(req.query.date)) ? req.query.date : null;
  const page = Math.max(parseInt(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
  const offset = (page - 1) * limit;

  try {
    const conditions = [];
    const params = [];
    if (employeeId != null) {
      params.push(employeeId);
      conditions.push(`nav.employee_id = $${params.length}`);
    }
    if (date != null) {
      params.push(date);
      conditions.push(`${businessDateExpr('nav.started_at')} = $${params.length}::date`);
    }
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const totalResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM dealer_navigations nav ${whereClause}`,
      params
    );
    const total = totalResult.rows[0].total;

    const rowsResult = await pool.query(
      `SELECT nav.id, nav.employee_id, e.name AS employee_name, nav.dealer_id, d.name AS dealer_name,
              nav.status, nav.distance_meters, nav.duration_seconds, nav.duration_in_traffic_seconds,
              nav.expected_arrival_time, nav.started_at, nav.ended_at
       FROM dealer_navigations nav
       JOIN employees e ON e.id = nav.employee_id
       JOIN dealers d ON d.id = nav.dealer_id
       ${whereClause}
       ORDER BY nav.started_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return res.json({
      navigations: rowsResult.rows,
      total,
      page,
      pageCount: Math.max(Math.ceil(total / limit), 1),
    });
  } catch (err) {
    logger.error('GET /api/navigation/history error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/navigation/summary/today — Daily Travel Summary, scoped to
// assignment-linked navigations (a manually-navigated, unassigned dealer
// doesn't count toward "assigned" totals).
router.get('/summary/today', async (req, res) => {
  const employeeId = req.employee.id;

  try {
    const assignmentCounts = await pool.query(
      `SELECT
         COUNT(*)::int AS total_assigned,
         COUNT(*) FILTER (WHERE status = 'completed')::int AS visited,
         COUNT(*) FILTER (WHERE status != 'completed' AND status != 'cancelled')::int AS pending
       FROM dealer_assignments
       WHERE employee_id = $1 AND assignment_date = ${businessDateExpr('NOW()')}`,
      [employeeId]
    );

    const navTotals = await pool.query(
      `SELECT
         COALESCE(SUM(distance_meters) FILTER (WHERE status = 'completed'), 0)::int AS distance_travelled_m,
         COALESCE(SUM(distance_meters) FILTER (WHERE status != 'completed' AND status != 'cancelled'), 0)::int AS remaining_distance_m,
         COALESCE(SUM(duration_seconds) FILTER (WHERE status = 'completed'), 0)::int AS driving_time_completed_s,
         COALESCE(SUM(duration_in_traffic_seconds) FILTER (WHERE status != 'completed' AND status != 'cancelled'), 0)::int AS estimated_remaining_time_s
       FROM dealer_navigations
       WHERE employee_id = $1 AND assignment_id IS NOT NULL
         AND ${businessDateExpr('started_at')} = ${businessDateExpr('NOW()')}`,
      [employeeId]
    );

    const counts = assignmentCounts.rows[0];
    const totals = navTotals.rows[0];

    return res.json({
      total_assigned_dealers: counts.total_assigned,
      visited_dealers: counts.visited,
      pending_dealers: counts.pending,
      total_planned_distance_m: totals.distance_travelled_m + totals.remaining_distance_m,
      distance_travelled_m: totals.distance_travelled_m,
      remaining_distance_m: totals.remaining_distance_m,
      total_driving_time_s: totals.driving_time_completed_s,
      estimated_remaining_time_s: totals.estimated_remaining_time_s,
      completed_visits: counts.visited,
      pending_visits: counts.pending,
    });
  } catch (err) {
    logger.error('GET /api/navigation/summary/today error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
