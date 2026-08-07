/**
 * syncFailures.routes.js — a rep's device reports here when a queued offline
 * action permanently fails to sync (retried past syncManager.js's MAX_RETRIES
 * and discarded). Without this, that discard was only a console.error on the
 * rep's own phone — invisible to everyone, including the manager whose team
 * member's dealer visit/attendance record may now be silently out of sync
 * with the server.
 *
 * POST /api/sync-failures — any authenticated employee (rep or manager).
 */
const express = require('express');
const logger = require('../utils/logger');
const { createManagerNotification } = require('../utils/managerNotifications');

const router = express.Router();

router.post('/', async (req, res) => {
  const { method, url, error } = req.body;
  const employeeId = req.employee.id;

  if (typeof url !== 'string' || !url) {
    return res.status(400).json({ error: 'url is required' });
  }

  try {
    await createManagerNotification({
      type: 'sync_failure',
      title: 'Offline action failed to sync',
      body: `${req.employee.username}'s device gave up retrying ${(method || 'post').toUpperCase()} ${url} — it never reached the server. Their attendance/visit records may be out of date.${error ? ` (${error})` : ''}`,
      severity: 'danger',
      employeeId,
    });
    return res.status(201).json({ success: true });
  } catch (err) {
    logger.error('POST /api/sync-failures error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
