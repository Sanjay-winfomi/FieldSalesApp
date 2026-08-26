/**
 * notifications.routes.js — manager-facing in-app notification bell feed.
 *
 * GET    /api/notifications              — list, newest first
 * GET    /api/notifications/unread-count — lightweight poll target for the bell badge
 * PATCH  /api/notifications/:id/read     — mark one read
 * POST   /api/notifications/read-all     — mark all unread as read (on opening the page)
 * DELETE /api/notifications/:id          — permanently remove one, only once
 *                                          it's actually reviewed/resolved
 *                                          (see DELETABLE_CONDITION below)
 * DELETE /api/notifications              — bulk version of the same rule —
 *                                          removes every currently-eligible
 *                                          notification in one call
 *
 * Read-state is shared across all managers, not per-manager-account — see
 * schema.sql's comment on manager_notifications for why.
 */
const express = require('express');
const logger = require('../utils/logger');
const pool    = require('../db/pool');

const router = express.Router();

// GET /api/notifications
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT n.id, n.type, n.title, n.body, n.severity, n.employee_id, e.name AS employee_name,
              n.dealer_id, d.name AS dealer_name, n.visit_id, n.read_at, n.created_at,
              n.followup_request_id, r.status AS followup_status,
              r.requested_date AS followup_requested_date, r.approved_date AS followup_approved_date
       FROM manager_notifications n
       LEFT JOIN employees e ON e.id = n.employee_id
       LEFT JOIN dealers d    ON d.id = n.dealer_id
       LEFT JOIN dealer_followup_requests r ON r.id = n.followup_request_id
       WHERE n.dismissed_at IS NULL
       ORDER BY n.created_at DESC
       LIMIT 200`
    );
    return res.json({ notifications: result.rows });
  } catch (err) {
    logger.error('GET /api/notifications error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/notifications/unread-count — registered before /:id so "unread-count" is never captured as an id
router.get('/unread-count', async (req, res) => {
  try {
    const result = await pool.query(`SELECT COUNT(*)::int AS count FROM manager_notifications WHERE read_at IS NULL AND dismissed_at IS NULL`);
    return res.json({ count: result.rows[0].count });
  } catch (err) {
    logger.error('GET /api/notifications/unread-count error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// A missed logout/login is serious enough that opening the notifications
// page shouldn't silently mark it read before a manager has actually looked
// at it and clicked "Reviewed" — every other notification type still gets
// the passive read-all-on-open behavior.
const REQUIRES_EXPLICIT_REVIEW = ['day_auto_cutoff', 'visit_auto_cutoff', 'day_absent'];

// Shared by both the single and bulk DELETE routes below — a notification
// is only ever deletable once it's actually done: a REQUIRES_EXPLICIT_REVIEW
// type with its Reviewed click already recorded, or a follow-up request
// already approved/rejected (not still pending). Every other notification
// type — including a REQUIRES_EXPLICIT_REVIEW type that's still unread —
// has no "resolved" concept at all and is never matched, so nothing still
// needing a manager's attention can ever be cleared away, one at a time or
// in bulk. `arrayParamIndex` is the 1-based position of the
// REQUIRES_EXPLICIT_REVIEW array parameter in that query's own params list
// (differs between the single-id route, which also binds the id, and the
// bulk route, which doesn't).
function deletableCondition(arrayParamIndex) {
  return `(
    (n.type = ANY($${arrayParamIndex}::varchar[]) AND n.read_at IS NOT NULL)
    OR (n.type = 'followup_request' AND EXISTS (
      SELECT 1 FROM dealer_followup_requests r
      WHERE r.id = n.followup_request_id AND r.status IN ('approved', 'rejected')
    ))
  )`;
}

// POST /api/notifications/read-all
router.post('/read-all', async (req, res) => {
  try {
    await pool.query(
      `UPDATE manager_notifications SET read_at = NOW() WHERE read_at IS NULL AND type != ALL($1::varchar[])`,
      [REQUIRES_EXPLICIT_REVIEW]
    );
    return res.json({ success: true });
  } catch (err) {
    logger.error('POST /api/notifications/read-all error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid notification id' });
  }
  try {
    const result = await pool.query(
      `UPDATE manager_notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = $1 RETURNING id, read_at`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    return res.json({ notification: result.rows[0] });
  } catch (err) {
    logger.error('PATCH /api/notifications/:id/read error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Clearing a notification removes it from the feed either way, but a
// 'day_absent' row is soft-dismissed (dismissed_at set) instead of actually
// deleted — absenceCheck.js's sweep re-flags the same (employee_id,
// business_date) pair every 15 minutes for as long as the rep still has no
// attendance row for it, and its dedup check is just "does a day_absent row
// for this pair still exist". A hard DELETE made the row's own existence
// stop guarding against that, so the exact same notification came back as a
// brand-new, unreviewed one on the next sweep. Leaving the row in place (just
// dismissed) keeps that guard intact while still disappearing from the feed
// (see the WHERE dismissed_at IS NULL above). Every other type has no such
// regenerate-on-delete risk, so it's still a real DELETE.
function clearNotificationsCTE(targetWhere) {
  return `
    WITH target AS (
      SELECT n.id, n.type FROM manager_notifications n WHERE ${targetWhere}
    ),
    dismissed AS (
      UPDATE manager_notifications SET dismissed_at = NOW()
      WHERE id IN (SELECT id FROM target WHERE type = 'day_absent')
      RETURNING id
    ),
    removed AS (
      DELETE FROM manager_notifications
      WHERE id IN (SELECT id FROM target WHERE type <> 'day_absent')
      RETURNING id
    )
    SELECT id FROM dismissed
    UNION ALL
    SELECT id FROM removed
  `;
}

// DELETE /api/notifications/:id — permanently clears one notification, if
// (and only if) deletableCondition matches it. Enforced here, not just
// hidden client-side, so this can't be bypassed by calling the endpoint
// directly.
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid notification id' });
  }
  try {
    const result = await pool.query(
      clearNotificationsCTE(`n.id = $1 AND ${deletableCondition(2)}`),
      [id, REQUIRES_EXPLICIT_REVIEW]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Notification not found, or not yet reviewed/resolved' });
    }
    return res.json({ success: true });
  } catch (err) {
    logger.error('DELETE /api/notifications/:id error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/notifications — bulk-clears every currently-eligible
// notification in one call (the "Clear all resolved" button) — same
// deletableCondition, just with no `id` filter. Reports how many were
// actually removed so the UI can show a real count rather than assuming
// every row shown as deletable client-side still was by the time this ran.
router.delete('/', async (req, res) => {
  try {
    const result = await pool.query(
      clearNotificationsCTE(deletableCondition(1)),
      [REQUIRES_EXPLICIT_REVIEW]
    );
    return res.json({ success: true, deleted: result.rows.length });
  } catch (err) {
    logger.error('DELETE /api/notifications error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
