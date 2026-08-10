/**
 * followupRequests.routes.js — a rep's ask for a dealer to be (re-)assigned
 * on a future date: an assigned dealer that couldn't be visited today, or
 * one that asked to be seen again on a specific day. Lands in the manager
 * notification feed with Approve/Reject actions; approving creates the
 * actual dealer_assignments row for the date the rep asked for.
 *
 * POST  /api/followup-requests           — rep: create a request
 * GET   /api/followup-requests           — manager-only: list (optional ?status=)
 * PATCH /api/followup-requests/:id/approve — manager-only: approve + assign
 * PATCH /api/followup-requests/:id/reject  — manager-only: reject
 */
const express = require('express');
const logger = require('../utils/logger');
const pool = require('../db/pool');
const { requireRole } = require('../middleware/auth.middleware');
const { createManagerNotification } = require('../utils/managerNotifications');

const router = express.Router();

const MIN_REASON_LENGTH = 10;

const REQUEST_FIELDS = 'r.id, r.employee_id, r.dealer_id, r.assignment_id, r.requested_date, r.reason, ' +
  'r.status, r.approved_date, r.resolved_by, r.resolved_at, r.created_at';

function validateReason(reason) {
  if (typeof reason !== 'string') return null;
  const trimmed = reason.trim();
  return trimmed.length >= MIN_REASON_LENGTH ? trimmed : null;
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

// POST /api/followup-requests  { dealer_id, assignment_id?, requested_date, reason }
router.post('/', async (req, res) => {
  const dealerId = parseInt(req.body.dealer_id);
  if (!Number.isInteger(dealerId)) {
    return res.status(400).json({ error: 'dealer_id is required' });
  }
  const assignmentId = req.body.assignment_id != null ? parseInt(req.body.assignment_id) : null;
  if (req.body.assignment_id != null && !Number.isInteger(assignmentId)) {
    return res.status(400).json({ error: 'Invalid assignment_id' });
  }
  const requestedDate = req.body.requested_date;
  if (typeof requestedDate !== 'string' || Number.isNaN(Date.parse(requestedDate))) {
    return res.status(400).json({ error: 'Invalid requested_date' });
  }
  if (requestedDate < todayDateString()) {
    return res.status(422).json({ error: 'requested_date_in_past' });
  }
  const reason = validateReason(req.body.reason);
  if (!reason) {
    return res.status(422).json({ error: 'reason_too_short', minLength: MIN_REASON_LENGTH });
  }

  const employeeId = req.employee.id;

  try {
    const dealerResult = await pool.query('SELECT id, name FROM dealers WHERE id = $1', [dealerId]);
    if (dealerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Dealer not found' });
    }
    const dealer = dealerResult.rows[0];

    if (assignmentId != null) {
      const assignmentResult = await pool.query(
        'SELECT id FROM dealer_assignments WHERE id = $1 AND employee_id = $2',
        [assignmentId, employeeId]
      );
      if (assignmentResult.rows.length === 0) {
        return res.status(404).json({ error: 'Assignment not found' });
      }
    }

    const result = await pool.query(
      `INSERT INTO dealer_followup_requests (employee_id, dealer_id, assignment_id, requested_date, reason)
       VALUES ($1, $2, $3, $4::date, $5) RETURNING ${REQUEST_FIELDS.replace(/r\./g, '')}`,
      [employeeId, dealerId, assignmentId, requestedDate, reason]
    );
    const request = result.rows[0];

    // Non-blocking-in-spirit but awaited (unlike visits.routes.js's
    // fire-and-forget markAssignmentVisited) — this notification IS the
    // point of the request; a rep submitting one should know it actually
    // reached the manager, not just that a local row got inserted.
    await createManagerNotification({
      type: 'followup_request',
      title: 'Follow-up visit requested',
      body: `${req.employee.username} asked to (re-)visit ${dealer.name} on ${requestedDate}. Reason: "${reason}"`,
      severity: 'info',
      employeeId,
      dealerId,
      followupRequestId: request.id,
    });

    return res.status(201).json({ request });
  } catch (err) {
    logger.error('POST /api/followup-requests error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/followup-requests?status=pending
router.get('/', requireRole('manager'), async (req, res) => {
  const { status } = req.query;
  if (status && !['pending', 'approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const result = await pool.query(
      `SELECT ${REQUEST_FIELDS}, e.name AS employee_name, d.name AS dealer_name
       FROM dealer_followup_requests r
       JOIN employees e ON e.id = r.employee_id
       JOIN dealers d ON d.id = r.dealer_id
       ${status ? 'WHERE r.status = $1' : ''}
       ORDER BY r.created_at DESC
       LIMIT 200`,
      status ? [status] : []
    );
    return res.json({ requests: result.rows });
  } catch (err) {
    logger.error('GET /api/followup-requests error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/followup-requests/:id/approve — creates/keeps the
// dealer_assignments row for the rep's requested date, appended after
// whatever's already assigned that day (never reorders existing entries).
router.patch('/:id/approve', requireRole('manager'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid request id' });
  }

  try {
    const existing = await pool.query('SELECT * FROM dealer_followup_requests WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }
    const request = existing.rows[0];
    if (request.status !== 'pending') {
      return res.status(409).json({ error: 'request_already_resolved', status: request.status });
    }

    // A manager can approve for a different day than the rep asked for
    // (e.g. that date is already full) — defaults to what was requested.
    let approvedDate = request.requested_date;
    if (req.body.approved_date != null) {
      if (typeof req.body.approved_date !== 'string' || Number.isNaN(Date.parse(req.body.approved_date))) {
        return res.status(400).json({ error: 'Invalid approved_date' });
      }
      if (req.body.approved_date < todayDateString()) {
        return res.status(422).json({ error: 'approved_date_in_past' });
      }
      approvedDate = req.body.approved_date;
    }

    const nextSeqResult = await pool.query(
      `SELECT COALESCE(MAX(sequence_order), 0) + 1 AS next_seq
       FROM dealer_assignments WHERE employee_id = $1 AND assignment_date = $2::date`,
      [request.employee_id, approvedDate]
    );
    const nextSeq = nextSeqResult.rows[0].next_seq;

    // ON CONFLICT DO UPDATE (a no-op field touch) rather than DO NOTHING —
    // guarantees RETURNING always gives back a row, including the case
    // where a manager separately assigned this same dealer+date already;
    // the request is still approved either way, since the assignment the
    // rep asked for now exists (existing sequence_order/status untouched).
    const assignmentResult = await pool.query(
      `INSERT INTO dealer_assignments (employee_id, dealer_id, assignment_date, sequence_order, assigned_by)
       VALUES ($1, $2, $3::date, $4, $5)
       ON CONFLICT (employee_id, dealer_id, assignment_date) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [request.employee_id, request.dealer_id, approvedDate, nextSeq, req.employee.id]
    );
    const assignmentId = assignmentResult.rows[0].id;

    const updated = await pool.query(
      `UPDATE dealer_followup_requests
       SET status = 'approved', approved_date = $1, resolved_by = $2, resolved_at = NOW()
       WHERE id = $3 RETURNING ${REQUEST_FIELDS.replace(/r\./g, '')}`,
      [approvedDate, req.employee.id, id]
    );

    return res.json({ request: updated.rows[0], assignment_id: assignmentId });
  } catch (err) {
    logger.error('PATCH /api/followup-requests/:id/approve error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/followup-requests/:id/reject
router.patch('/:id/reject', requireRole('manager'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid request id' });
  }

  try {
    const existing = await pool.query('SELECT status FROM dealer_followup_requests WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }
    if (existing.rows[0].status !== 'pending') {
      return res.status(409).json({ error: 'request_already_resolved', status: existing.rows[0].status });
    }

    const result = await pool.query(
      `UPDATE dealer_followup_requests SET status = 'rejected', resolved_by = $1, resolved_at = NOW()
       WHERE id = $2 RETURNING ${REQUEST_FIELDS.replace(/r\./g, '')}`,
      [req.employee.id, id]
    );
    return res.json({ request: result.rows[0] });
  } catch (err) {
    logger.error('PATCH /api/followup-requests/:id/reject error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
