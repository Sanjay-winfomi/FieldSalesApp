/**
 * assignments.routes.js — manager-authored, ordered dealer visit plans.
 *
 * GET    /api/assignments        — manager-only: a rep's assignments for a date
 * PUT    /api/assignments        — manager-only: create/replace/reorder a rep's
 *                                    ordered dealer list for a date
 * DELETE /api/assignments/:id    — manager-only: remove a single dealer from an assignment
 * GET    /api/assignments/today  — rep-only: the caller's own assigned dealers for today
 *
 * The sequence here is set exactly once by whichever PUT the manager last
 * saved — nothing in this file (or anywhere else) ever reorders it.
 * Editing/removing an assignment never touches client_visits/attendance.
 */
const express = require('express');
const logger = require('../utils/logger');
const pool = require('../db/pool');
const { requireRole } = require('../middleware/auth.middleware');
const { businessDateExpr } = require('../utils/businessDay');

const router = express.Router();

const ASSIGNMENT_FIELDS = 'da.id, da.employee_id, da.dealer_id, da.assignment_date, da.sequence_order, ' +
  'da.assigned_by, da.status, da.created_at, da.updated_at';

function parseDateParam(value) {
  if (!value) return null;
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : undefined; // undefined = invalid
}

// GET /api/assignments?employee_id=&date=
router.get('/', requireRole('manager'), async (req, res) => {
  const employeeId = parseInt(req.query.employee_id);
  if (!Number.isInteger(employeeId)) {
    return res.status(400).json({ error: 'employee_id is required' });
  }
  const dateParam = parseDateParam(req.query.date);
  if (dateParam === undefined) {
    return res.status(400).json({ error: 'Invalid date' });
  }

  try {
    const result = await pool.query(
      `SELECT ${ASSIGNMENT_FIELDS}, d.name AS dealer_name, d.address AS dealer_address,
              d.latitude AS dealer_lat, d.longitude AS dealer_lng, d.radius_meters
       FROM dealer_assignments da
       JOIN dealers d ON d.id = da.dealer_id
       WHERE da.employee_id = $1
         AND da.assignment_date = COALESCE($2::date, ${businessDateExpr('NOW()')})
       ORDER BY da.sequence_order ASC`,
      [employeeId, dateParam]
    );
    return res.json({ assignments: result.rows });
  } catch (err) {
    logger.error('GET /api/assignments error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/assignments  { employee_id, assignment_date, dealer_ids: [ordered] }
router.put('/', requireRole('manager'), async (req, res) => {
  const employeeId = parseInt(req.body.employee_id);
  if (!Number.isInteger(employeeId)) {
    return res.status(400).json({ error: 'employee_id is required' });
  }
  const assignmentDate = parseDateParam(req.body.assignment_date);
  if (!assignmentDate) {
    return res.status(400).json({ error: 'assignment_date is required' });
  }
  const dealerIds = req.body.dealer_ids;
  if (!Array.isArray(dealerIds) || dealerIds.some((id) => !Number.isInteger(id))) {
    return res.status(400).json({ error: 'dealer_ids must be an array of dealer ids' });
  }
  // Order in the array IS the sequence — de-dup while preserving first
  // occurrence, so a client accidentally sending the same dealer twice
  // doesn't collide on the UNIQUE(employee_id, dealer_id, assignment_date)
  // constraint below.
  const orderedDealerIds = [...new Set(dealerIds)];

  // A transaction, not one autocommit query per statement — without it, a
  // failure partway through the upsert loop left the DB matching neither the
  // old nor new plan, and two concurrent saves for the same employee/date
  // could interleave (one's DELETE running after the other's INSERTs),
  // silently dropping one manager's update.
  const client = await pool.connect();
  try {
    const employeeResult = await client.query(`SELECT id FROM employees WHERE id = $1 AND role = 'rep'`, [employeeId]);
    if (employeeResult.rows.length === 0) {
      client.release();
      return res.status(404).json({ error: 'Representative not found' });
    }

    if (orderedDealerIds.length > 0) {
      const dealerResult = await client.query(
        `SELECT id FROM dealers WHERE id = ANY($1::int[])`,
        [orderedDealerIds]
      );
      if (dealerResult.rows.length !== orderedDealerIds.length) {
        client.release();
        return res.status(404).json({ error: 'One or more dealers not found' });
      }
    }

    await client.query('BEGIN');

    // Transaction-scoped advisory lock keyed by employee_id + date (not a
    // row lock, since a first-ever save for this employee/date has no
    // existing rows to lock) — a concurrent PUT for the same employee/date
    // waits here instead of interleaving its DELETE/INSERTs with ours.
    // Released automatically on COMMIT/ROLLBACK.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('dealer_assignments:' || $1 || ':' || $2::date))`,
      [employeeId, assignmentDate]
    );

    // Drop anything not in the new list — a manager removing a dealer from
    // the plan is expressed by simply leaving it out of dealer_ids.
    await client.query(
      `DELETE FROM dealer_assignments
       WHERE employee_id = $1 AND assignment_date = $2::date
         AND ($3::int[] = '{}' OR NOT (dealer_id = ANY($3::int[])))`,
      [employeeId, assignmentDate, orderedDealerIds]
    );

    // Upsert each dealer at its new position. ON CONFLICT deliberately does
    // NOT touch status/created_at — reordering or re-saving an assignment
    // must never reset a dealer that's already been marked completed today.
    for (let i = 0; i < orderedDealerIds.length; i++) {
      await client.query(
        `INSERT INTO dealer_assignments (employee_id, dealer_id, assignment_date, sequence_order, assigned_by)
         VALUES ($1, $2, $3::date, $4, $5)
         ON CONFLICT (employee_id, dealer_id, assignment_date)
         DO UPDATE SET sequence_order = EXCLUDED.sequence_order, updated_at = NOW()`,
        [employeeId, orderedDealerIds[i], assignmentDate, i + 1, req.employee.id]
      );
    }

    const result = await client.query(
      `SELECT ${ASSIGNMENT_FIELDS}, d.name AS dealer_name, d.address AS dealer_address,
              d.latitude AS dealer_lat, d.longitude AS dealer_lng, d.radius_meters
       FROM dealer_assignments da
       JOIN dealers d ON d.id = da.dealer_id
       WHERE da.employee_id = $1 AND da.assignment_date = $2::date
       ORDER BY da.sequence_order ASC`,
      [employeeId, assignmentDate]
    );

    await client.query('COMMIT');
    return res.json({ assignments: result.rows });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('PUT /api/assignments error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// DELETE /api/assignments/:id
router.delete('/:id', requireRole('manager'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid assignment id' });
  }

  try {
    const existing = await pool.query('SELECT id FROM dealer_assignments WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    await pool.query('DELETE FROM dealer_assignments WHERE id = $1', [id]);
    return res.json({ success: true });
  } catch (err) {
    logger.error('DELETE /api/assignments/:id error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/assignments/today — the caller's own assigned dealers for today,
// with the most recent navigation attempt (if any) so the mobile Home card
// can show distance/ETA/status without the rep having to reopen the nav
// screen for something already computed earlier today.
router.get('/today', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${ASSIGNMENT_FIELDS}, d.name AS dealer_name, d.address AS dealer_address,
              d.latitude AS dealer_lat, d.longitude AS dealer_lng, d.radius_meters,
              nav.id AS navigation_id, nav.status AS navigation_status,
              nav.distance_meters, nav.duration_seconds, nav.duration_in_traffic_seconds,
              nav.expected_arrival_time
       FROM dealer_assignments da
       JOIN dealers d ON d.id = da.dealer_id
       LEFT JOIN LATERAL (
         SELECT id, status, distance_meters, duration_seconds, duration_in_traffic_seconds, expected_arrival_time
         FROM dealer_navigations
         WHERE assignment_id = da.id
         ORDER BY started_at DESC
         LIMIT 1
       ) nav ON true
       WHERE da.employee_id = $1 AND da.assignment_date = ${businessDateExpr('NOW()')}
       ORDER BY da.sequence_order ASC`,
      [req.employee.id]
    );
    return res.json({ assignments: result.rows });
  } catch (err) {
    logger.error('GET /api/assignments/today error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
