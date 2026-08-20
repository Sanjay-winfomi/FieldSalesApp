/**
 * absenceCheck.js — flags a rep who never logged in at all for the day, so
 * a manager finds out the same night instead of only noticing when nothing
 * shows up in tomorrow's report. Distinct from autoCutoff.js: that handles a
 * rep who logged in but forgot to log out; this handles a rep who never
 * opened the app at all.
 *
 * "By 11pm" per business day (5am-to-5am IST, same boundary as everywhere
 * else in this app) — a rep with no attendance row for a business date,
 * once that date's own 11:00 PM IST has passed, is flagged as a probable
 * absence. Checks the last 3 business dates (not just today) so a Render
 * free-tier spin-down sleeping through the 11pm-5am window doesn't lose
 * anything — the next tick after waking still finds and flags it.
 *
 * Deliberately simple: there's no leave/roster concept in this schema, so
 * every active rep who didn't log in gets flagged, including weekends/
 * holidays if the company doesn't route around this endpoint on those days.
 * Safe to call as often as you like — dedupes against a notification
 * already sent for the same employee + business date, so a run that finds
 * nothing new is a no-op.
 */
const pool = require('../db/pool');
const logger = require('./logger');
const { createManagerNotification } = require('./managerNotifications');
const { businessDateExpr } = require('./businessDay');

const LOOKBACK_DAYS = 2; // plus today = 3 business dates checked each run

async function flagAbsentReps() {
  const result = await pool.query(
    `WITH business_dates AS (
       SELECT d::date AS business_date
       FROM generate_series(
         ${businessDateExpr('NOW()')} - INTERVAL '${LOOKBACK_DAYS} days',
         ${businessDateExpr('NOW()')},
         INTERVAL '1 day'
       ) d
     ),
     -- A business date's "11pm" is 11pm IST on the calendar day the business
     -- date represents (the date itself, since the 5am-to-5am span is named
     -- after the day it starts on) — not the following calendar day.
     eligible_dates AS (
       SELECT business_date FROM business_dates
       WHERE NOW() >= (business_date + INTERVAL '23 hours') AT TIME ZONE 'Asia/Kolkata'
     )
     SELECT e.id AS employee_id, e.username, ed.business_date
     FROM eligible_dates ed
     CROSS JOIN employees e
     WHERE e.role = 'rep' AND e.is_active = true
       AND NOT EXISTS (
         SELECT 1 FROM attendance a WHERE a.employee_id = e.id AND a.business_date = ed.business_date
       )
       AND NOT EXISTS (
         SELECT 1 FROM manager_notifications n
         WHERE n.employee_id = e.id AND n.type = 'day_absent'
           AND ${businessDateExpr('n.created_at')} = ed.business_date
       )`
  );

  for (const row of result.rows) {
    try {
      const dateLabel = new Date(row.business_date).toLocaleDateString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
      });
      await createManagerNotification({
        type: 'day_absent',
        title: 'Representative did not log in',
        body: `${row.username} did not log in on ${dateLabel} — likely absent, follow up if unplanned.`,
        severity: 'danger',
        employeeId: row.employee_id,
        businessDate: row.business_date,
      });
    } catch (err) {
      logger.error('Failed to notify for absent rep', { employeeId: row.employee_id, error: err.message });
    }
  }
  return result.rows.length;
}

async function runAbsenceCheckSweep() {
  try {
    const flagged = await flagAbsentReps();
    if (flagged > 0) {
      logger.info('Absence check flagged reps who did not log in', { flagged });
    }
  } catch (err) {
    logger.error('Absence check sweep failed', { error: err.message, stack: err.stack });
  }
}

const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

// Same reasoning as autoCutoff.js's own STARTUP_DELAY_MS: this sweep exists
// to catch an 11 PM threshold that's always already passed by the time this
// process runs, and Render's free tier spins down after ~15 minutes idle —
// resetting every in-memory timer on each wake. Relying on SWEEP_INTERVAL_MS
// alone means a cold-start that doesn't happen to stay up a full continuous
// 15 minutes can go arbitrarily long without ever ticking, leaving a
// genuinely-absent rep unflagged well past 11 PM. Runs once shortly after
// every boot in addition to the interval — still not synchronously at
// require-time (a bare require() of this module must never itself perform a
// query), just delayed past any realistic test file's own run time.
const STARTUP_DELAY_MS = 30 * 1000;

const startupTimeout = setTimeout(runAbsenceCheckSweep, STARTUP_DELAY_MS);
startupTimeout.unref();

// unref() so this timer never keeps the process alive on its own — mirrors
// autoCutoff.js's/idempotency.js's own sweeps.
const sweepInterval = setInterval(runAbsenceCheckSweep, SWEEP_INTERVAL_MS);
sweepInterval.unref();

module.exports = { runAbsenceCheckSweep };
