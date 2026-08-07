/**
 * notifications.routes.js — manager-facing in-app notification bell feed.
 *
 * GET   /api/notifications              — list, newest first
 * GET   /api/notifications/unread-count — lightweight poll target for the bell badge
 * PATCH /api/notifications/:id/read     — mark one read
 * POST  /api/notifications/read-all     — mark all unread as read (on opening the page)
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
              n.dealer_id, d.name AS dealer_name, n.visit_id, n.read_at, n.created_at
       FROM manager_notifications n
       LEFT JOIN employees e ON e.id = n.employee_id
       LEFT JOIN dealers d    ON d.id = n.dealer_id
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
    const result = await pool.query(`SELECT COUNT(*)::int AS count FROM manager_notifications WHERE read_at IS NULL`);
    return res.json({ count: result.rows[0].count });
  } catch (err) {
    logger.error('GET /api/notifications/unread-count error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/notifications/read-all
router.post('/read-all', async (req, res) => {
  try {
    await pool.query(`UPDATE manager_notifications SET read_at = NOW() WHERE read_at IS NULL`);
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

module.exports = router;
