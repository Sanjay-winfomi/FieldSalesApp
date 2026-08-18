/**
 * autoCutoff.js — auto-closes a forgotten day-logout or dealer-visit-logout
 * at 1:00 AM IST, so a rep who simply never taps Logout doesn't leave their
 * attendance/visit open forever (no duration ever recorded, and "today's
 * hours"/"today's visit" screens showing a stale in-progress state
 * indefinitely). Distinct from attendance.routes.js's existing auto-close
 * of an open visit AT day-logout time — that only fires once the rep
 * eventually does log out for the day. This handles the case where they
 * never do, by running proactively on a timer instead of waiting on them.
 *
 * Idempotent and safe to call as often as you like (e.g. every 15 minutes,
 * or right after server boot) — each run just finds whatever's still open
 * from before the most recent 1:00 AM IST and closes it; a run that finds
 * nothing new is a no-op. This also means a Render free-tier spin-down
 * sleeping through the exact 1:00 AM instant doesn't lose anything — the
 * next run (on wake, or the next scheduled tick) still finds and closes
 * anything overdue.
 */
const pool = require('../db/pool');
const logger = require('./logger');
const { createManagerNotification } = require('./managerNotifications');

// The most recent 1:00 AM IST instant at or before NOW(), as a timestamptz —
// "today's 1am IST" if it's already past that time, else "yesterday's 1am
// IST". Mirrors businessDay.js's own AT TIME ZONE 'Asia/Kolkata' approach for
// consistency with the rest of the app's IST-based day-boundary logic.
const CUTOFF_INSTANT_EXPR = `(
  (CASE
     WHEN (NOW() AT TIME ZONE 'Asia/Kolkata')::time >= TIME '01:00:00'
       THEN DATE(NOW() AT TIME ZONE 'Asia/Kolkata')
     ELSE DATE(NOW() AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 day'
   END) + INTERVAL '1 hour'
) AT TIME ZONE 'Asia/Kolkata'`;

// No GPS/route data available for a cutoff that never actually happened at
// the dealer/home — logout_lat/lng and distance fields are left NULL/
// untouched (unlike a real logout), same as the existing auto-close-at-
// day-logout code already does for exactly this reason.
async function cutoffOpenVisits() {
  const result = await pool.query(
    `UPDATE client_visits cv
     SET logout_time = ${CUTOFF_INSTANT_EXPR},
         visit_duration_minutes = GREATEST(0, ROUND(EXTRACT(EPOCH FROM (${CUTOFF_INSTANT_EXPR} - cv.login_time)) / 60))::int,
         logout_justification_note = 'Auto-closed: rep did not log out of this dealer — cut off at 1:00 AM.'
     WHERE cv.logout_time IS NULL AND cv.login_time < ${CUTOFF_INSTANT_EXPR}
     RETURNING cv.id, cv.attendance_id, cv.dealer_id, cv.visit_duration_minutes`
  );

  for (const visit of result.rows) {
    try {
      const infoResult = await pool.query(
        `SELECT a.employee_id, e.username, d.name AS dealer_name
         FROM attendance a
         JOIN employees e ON e.id = a.employee_id
         JOIN dealers d ON d.id = $2
         WHERE a.id = $1`,
        [visit.attendance_id, visit.dealer_id]
      );
      const info = infoResult.rows[0];
      if (!info) continue;
      const hours = (visit.visit_duration_minutes / 60).toFixed(1);
      await createManagerNotification({
        type: 'visit_auto_cutoff',
        title: 'Dealer visit auto-closed (missed logout)',
        body: `${info.username} did not log out of ${info.dealer_name} — automatically closed at 1:00 AM after ${hours}h.`,
        severity: 'warning',
        employeeId: info.employee_id,
        dealerId: visit.dealer_id,
        visitId: visit.id,
      });
    } catch (err) {
      logger.error('Failed to notify for auto-cutoff visit', { visitId: visit.id, error: err.message });
    }
  }
  return result.rows.length;
}

async function cutoffOpenAttendance() {
  const result = await pool.query(
    `UPDATE attendance a
     SET logout_time = ${CUTOFF_INSTANT_EXPR},
         total_duration_minutes = GREATEST(0, ROUND(EXTRACT(EPOCH FROM (${CUTOFF_INSTANT_EXPR} - a.login_time)) / 60))::int
     WHERE a.logout_time IS NULL AND a.login_time < ${CUTOFF_INSTANT_EXPR}
     RETURNING a.id, a.employee_id, a.total_duration_minutes`
  );

  for (const att of result.rows) {
    try {
      const empResult = await pool.query(`SELECT username FROM employees WHERE id = $1`, [att.employee_id]);
      const username = empResult.rows[0]?.username || `Employee #${att.employee_id}`;
      const hours = (att.total_duration_minutes / 60).toFixed(1);
      await createManagerNotification({
        type: 'day_auto_cutoff',
        title: 'Day auto-logged-out (missed logout)',
        body: `${username} did not log out for the day — automatically closed at 1:00 AM after ${hours}h.`,
        severity: 'warning',
        employeeId: att.employee_id,
      });
    } catch (err) {
      logger.error('Failed to notify for auto-cutoff attendance', { attendanceId: att.id, error: err.message });
    }
  }
  return result.rows.length;
}

// Visits swept before attendance (same order the day-logout auto-close
// already uses) — purely conventional here, since neither UPDATE reads
// state the other one writes.
async function runAutoCutoffSweep() {
  try {
    const visitsClosed = await cutoffOpenVisits();
    const attendanceClosed = await cutoffOpenAttendance();
    if (visitsClosed > 0 || attendanceClosed > 0) {
      logger.info('Auto-cutoff sweep closed forgotten logouts', { visitsClosed, attendanceClosed });
    }
  } catch (err) {
    logger.error('Auto-cutoff sweep failed', { error: err.message, stack: err.stack });
  }
}

const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

// unref() so this timer never keeps the process alive on its own (relevant
// for tests and clean shutdowns) — mirrors idempotency.js's own sweep. Not
// run immediately at require-time (only on the first tick, up to
// SWEEP_INTERVAL_MS after boot) for the same reason idempotency.js's cleanup
// isn't: a bare require() of this module must never itself perform a query.
const sweepInterval = setInterval(runAutoCutoffSweep, SWEEP_INTERVAL_MS);
sweepInterval.unref();

module.exports = { runAutoCutoffSweep, __testing: { CUTOFF_INSTANT_EXPR } };
