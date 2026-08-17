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
const { getBusinessDateString } = require('../utils/businessDay');
const { getIdempotentResponse, saveIdempotentResponse } = require('../utils/idempotency');

const router = express.Router();

const MIN_REASON_LENGTH = 10;

const REQUEST_FIELDS = 'r.id, r.employee_id, r.dealer_id, r.assignment_id, r.requested_date, r.reason, ' +
  'r.status, r.approved_date, r.resolved_by, r.resolved_at, r.created_at';

function validateReason(reason) {
  if (typeof reason !== 'string') return null;
  const trimmed = reason.trim();
  return trimmed.length >= MIN_REASON_LENGTH ? trimmed : null;
}

// Strict YYYY-MM-DD check — Date.parse() accepts many non-ISO formats
// (e.g. "08-13-2026") whose string-lexicographic order doesn't match
// calendar order, which broke the plain string `<` comparison against
// todayDateString() used for the past-date guards below.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDateString(value) {
  if (typeof value !== 'string' || !DATE_ONLY_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime());
}

// "Today" here means the current business day (5am IST rollover, see
// businessDay.js) — the plain UTC calendar date would drift from it by up
// to DAY_BOUNDARY_HOUR minutes once a day, right after the boundary rolls
// over in IST but before the server's UTC calendar date does too.
function todayDateString() {
  return getBusinessDateString();
}

// POST /api/followup-requests  { dealer_id, assignment_id?, requested_date, reason }
// rep-only: this is "a rep's ask" for a dealer to be (re-)assigned — a
// manager doesn't need this route since they can just save an assignment
// directly via PUT /api/assignments.
router.post('/', requireRole('rep'), async (req, res) => {
  const dealerId = parseInt(req.body.dealer_id);
  if (!Number.isInteger(dealerId)) {
    return res.status(400).json({ error: 'dealer_id is required' });
  }
  const assignmentId = req.body.assignment_id != null ? parseInt(req.body.assignment_id) : null;
  if (req.body.assignment_id != null && !Number.isInteger(assignmentId)) {
    return res.status(400).json({ error: 'Invalid assignment_id' });
  }
  const requestedDate = req.body.requested_date;
  if (!isValidDateString(requestedDate)) {
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
  const idempotencyKey = req.get('Idempotency-Key') || null;

  try {
    // The offline sync queue (mobile syncManager.js) retries this exact
    // request — same Idempotency-Key — whenever the network drops between
    // the server completing the insert and the client seeing the response.
    // Without this check, that retry created a second dealer_followup_requests
    // row and sent the manager a duplicate notification for one ask.
    const cached = await getIdempotentResponse(idempotencyKey, employeeId, 'followup-requests');
    if (cached) {
      return res.status(cached.response_status).json(cached.response_body);
    }

    const dealerResult = await pool.query('SELECT id, name FROM dealers WHERE id = $1', [dealerId]);
    if (dealerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Dealer not found' });
    }
    const dealer = dealerResult.rows[0];

    if (assignmentId != null) {
      // Must also match dealer_id (same guard as navigation.routes.js's
      // /compute) — without it, a rep could pass an assignment_id for a
      // completely different dealer than dealer_id in this same request,
      // storing a request whose linked assignment doesn't match what it's
      // actually about.
      const assignmentResult = await pool.query(
        'SELECT id FROM dealer_assignments WHERE id = $1 AND employee_id = $2 AND dealer_id = $3',
        [assignmentId, employeeId, dealerId]
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

    const body = { request };
    await saveIdempotentResponse(idempotencyKey, employeeId, 'followup-requests', 201, body);
    return res.status(201).json(body);
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

  // A dedicated client + transaction (rather than pool.query per statement)
  // — without this, two followup requests for the same employee/date
  // approved concurrently (two managers, or a double-click) could both read
  // the same MAX(sequence_order) before either INSERT commits, producing two
  // assignments with duplicate sequence_order and ambiguous visit ordering.
  // The advisory lock is the same one PUT /api/assignments already takes for
  // this employee/date, so the two routes properly serialize against each
  // other too, not just against themselves.
  const client = await pool.connect();
  try {
    const existing = await client.query('SELECT * FROM dealer_followup_requests WHERE id = $1', [id]);
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
      if (!isValidDateString(req.body.approved_date)) {
        return res.status(400).json({ error: 'Invalid approved_date' });
      }
      if (req.body.approved_date < todayDateString()) {
        return res.status(422).json({ error: 'approved_date_in_past' });
      }
      approvedDate = req.body.approved_date;
    }

    await client.query('BEGIN');

    // Transaction-scoped advisory lock keyed by employee_id + date — see
    // assignments.routes.js's PUT handler for the identical pattern.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('dealer_assignments:' || $1 || ':' || $2::date))`,
      [request.employee_id, approvedDate]
    );

    // Claims the pending->approved transition atomically BEFORE creating any
    // assignment — `AND status = 'pending'` means only one of a concurrent
    // approve/reject race can ever win this UPDATE. Without this, two
    // requests racing (e.g. a manager double-clicking, or two managers)
    // could both pass the earlier status check and each proceed with their
    // own side effect, leaving the request rejected while an assignment
    // from the "approve" path still got created. Ordering the claim before
    // the assignment INSERT means the loser returns 409 having created
    // nothing, rather than leaving a stray assignment behind either way.
    const updated = await client.query(
      `UPDATE dealer_followup_requests
       SET status = 'approved', approved_date = $1, resolved_by = $2, resolved_at = NOW()
       WHERE id = $3 AND status = 'pending'
       RETURNING ${REQUEST_FIELDS.replace(/r\./g, '')}`,
      [approvedDate, req.employee.id, id]
    );
    if (updated.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'request_already_resolved' });
    }

    const nextSeqResult = await client.query(
      `SELECT COALESCE(MAX(sequence_order), 0) + 1 AS next_seq
       FROM dealer_assignments WHERE employee_id = $1 AND assignment_date = $2::date`,
      [request.employee_id, approvedDate]
    );
    const nextSeq = nextSeqResult.rows[0].next_seq;

    // ON CONFLICT DO UPDATE rather than DO NOTHING — guarantees RETURNING
    // always gives back a row, including when a manager separately assigned
    // this same dealer+date already. If that existing row was 'cancelled'
    // (e.g. the manager pre-cancelled it before this request was approved),
    // reactivate it to 'pending' with a fresh sequence_order — otherwise the
    // request reads as "approved" while the rep's assignment list still
    // shows it cancelled. Any other existing status (pending/navigating/
    // arrived/completed) is left untouched, same as before.
    const assignmentResult = await client.query(
      `INSERT INTO dealer_assignments (employee_id, dealer_id, assignment_date, sequence_order, assigned_by)
       VALUES ($1, $2, $3::date, $4, $5)
       ON CONFLICT (employee_id, dealer_id, assignment_date) DO UPDATE SET
         status = CASE WHEN dealer_assignments.status = 'cancelled' THEN 'pending' ELSE dealer_assignments.status END,
         sequence_order = CASE WHEN dealer_assignments.status = 'cancelled' THEN EXCLUDED.sequence_order ELSE dealer_assignments.sequence_order END,
         updated_at = NOW()
       RETURNING id`,
      [request.employee_id, request.dealer_id, approvedDate, nextSeq, req.employee.id]
    );
    const assignmentId = assignmentResult.rows[0].id;

    await client.query('COMMIT');
    return res.json({ request: updated.rows[0], assignment_id: assignmentId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('PATCH /api/followup-requests/:id/approve error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
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

    // `AND status = 'pending'` makes this the atomic claim on the
    // transition (see the matching comment in /approve) — if an
    // approve/reject race already resolved it between the check above and
    // this UPDATE, rowCount is 0 here instead of silently overwriting
    // whatever the other request just committed.
    const result = await pool.query(
      `UPDATE dealer_followup_requests SET status = 'rejected', resolved_by = $1, resolved_at = NOW()
       WHERE id = $2 AND status = 'pending'
       RETURNING ${REQUEST_FIELDS.replace(/r\./g, '')}`,
      [req.employee.id, id]
    );
    if (result.rows.length === 0) {
      return res.status(409).json({ error: 'request_already_resolved' });
    }
    return res.json({ request: result.rows[0] });
  } catch (err) {
    logger.error('PATCH /api/followup-requests/:id/reject error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
