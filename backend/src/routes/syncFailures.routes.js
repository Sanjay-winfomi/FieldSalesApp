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
const pool = require('../db/pool');
const { createManagerNotification } = require('../utils/managerNotifications');

const router = express.Router();

// A device stuck on a bad connection can generate the same discarded action
// repeatedly (e.g. a recurring location-check ping failing the same way
// every 10 minutes) — without this, each one lands as its own manager
// notification and the feed turns into noise for what is really one
// ongoing problem. Suppress a duplicate for the same employee+endpoint
// within this window rather than inserting another row.
const DEDUP_WINDOW_MINUTES = 60;

router.post('/', async (req, res) => {
  const { method, url, error } = req.body;
  const employeeId = req.employee.id;

  if (typeof url !== 'string' || !url) {
    return res.status(400).json({ error: 'url is required' });
  }

  try {
    // Escape LIKE metacharacters in the (client-controlled) url/method before
    // building the pattern — otherwise a url containing a literal "%" or "_"
    // (e.g. a query string) would act as a wildcard, matching a broader (or
    // narrower) set of prior bodies than the actual method+url and dedupe
    // either too aggressively or not at all.
    const escapedTarget = `${(method || 'post').toUpperCase()} ${url}`.replace(/[\\%_]/g, (c) => `\\${c}`);
    const duplicate = await pool.query(
      `SELECT 1 FROM manager_notifications
       WHERE type = 'sync_failure' AND employee_id = $1 AND body LIKE $2 ESCAPE '\\'
         AND created_at > NOW() - INTERVAL '${DEDUP_WINDOW_MINUTES} minutes'
       LIMIT 1`,
      [employeeId, `%${escapedTarget}%`]
    );
    if (duplicate.rows.length > 0) {
      return res.status(201).json({ success: true, deduped: true });
    }

    // Endpoint is generic (notes/reminders can queue offline too now, not
    // just attendance/visit), so the copy doesn't assume which kind of
    // record is affected.
    await createManagerNotification({
      type: 'sync_failure',
      title: 'Offline action failed to sync',
      body: `${req.employee.username}'s device gave up retrying ${(method || 'post').toUpperCase()} ${url} — it never reached the server. Whatever they were saving may be lost or out of date.${error ? ` (${error})` : ''}`,
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
