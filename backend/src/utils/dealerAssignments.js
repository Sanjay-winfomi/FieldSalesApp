/**
 * dealerAssignments.js — small helpers shared between assignments.routes.js,
 * navigation.routes.js, and the one non-blocking hook into the existing
 * dealer check-in flow (visits.routes.js).
 */
const logger = require('./logger');
const pool = require('../db/pool');
const { businessDateExpr } = require('./businessDay');
const { createManagerNotification } = require('./managerNotifications');

/**
 * Marks today's dealer_assignments row (if one exists) for this
 * employee+dealer as completed — called as a side effect of an existing
 * dealer check-in. Mirrors managerNotifications.js's defensive style
 * exactly: wrapped in try/catch, logs on failure, NEVER throws — a rep's
 * check-in must succeed regardless of whether an assignment happens to
 * exist or this update happens to fail.
 *
 * Also closes out that assignment's most recent open dealer_navigations
 * row (status 'navigating' or 'arrived') to 'completed' — without this,
 * no code path ever set a navigation row to 'completed' (only 'arrived' via
 * the mobile app's auto-arrival poll, or 'cancelled'), so
 * GET /api/navigation/summary/today's distance/duration totals — which
 * only sum rows WHERE status = 'completed' — would always read zero, and
 * GET /api/navigation/history would show "Arrived" forever instead of the
 * actual outcome.
 * @param {object} opts
 * @param {number} opts.employeeId
 * @param {number} opts.dealerId
 */
async function markAssignmentVisited({ employeeId, dealerId }) {
  try {
    const result = await pool.query(
      `UPDATE dealer_assignments
       SET status = 'completed', updated_at = NOW()
       WHERE employee_id = $1 AND dealer_id = $2
         AND assignment_date = ${businessDateExpr('NOW()')}
         AND status != 'completed'
       RETURNING id`,
      [employeeId, dealerId]
    );
    const assignmentId = result.rows[0]?.id;
    if (assignmentId != null) {
      await pool.query(
        `UPDATE dealer_navigations
         SET status = 'completed', ended_at = NOW()
         WHERE assignment_id = $1 AND status IN ('navigating', 'arrived')`,
        [assignmentId]
      );
    }
  } catch (err) {
    logger.error('Failed to mark dealer assignment visited', { error: err.message, employeeId, dealerId });
  }
}

/**
 * End-of-day check, called as a side effect of the existing Day Logout
 * (see attendance.routes.js) — if the rep is ending the day with any
 * assigned dealer still not completed/cancelled, notifies managers with the
 * full list. Without this, an unvisited dealer was invisible to the
 * manager unless the rep proactively used "Request follow-up" (opt-in, per
 * dealer) — a rep who simply ran out of time and closed the app left no
 * trace at all. Same defensive style as markAssignmentVisited: wrapped in
 * try/catch, logs on failure, NEVER throws — Day Logout must succeed
 * regardless of whether this check or the notification write fails.
 * @param {object} opts
 * @param {number} opts.employeeId
 */
async function notifyUnvisitedAssignments({ employeeId }) {
  try {
    const result = await pool.query(
      `SELECT d.name AS dealer_name
       FROM dealer_assignments da
       JOIN dealers d ON d.id = da.dealer_id
       WHERE da.employee_id = $1
         AND da.assignment_date = ${businessDateExpr('NOW()')}
         AND da.status NOT IN ('completed', 'cancelled')
       ORDER BY da.sequence_order ASC`,
      [employeeId]
    );
    if (result.rows.length === 0) return;

    const employeeResult = await pool.query('SELECT username FROM employees WHERE id = $1', [employeeId]);
    const username = employeeResult.rows[0]?.username || `Employee #${employeeId}`;
    const dealerNames = result.rows.map((r) => r.dealer_name);

    const body = dealerNames.length === 1
      ? `${username} ended the day without visiting ${dealerNames[0]}.`
      : `${username} ended the day without visiting ${dealerNames.length} assigned dealers: ${dealerNames.join(', ')}.`;

    await createManagerNotification({
      type: 'unvisited_assignments',
      title: 'Assigned dealer(s) not visited today',
      body,
      severity: 'warning',
      employeeId,
    });
  } catch (err) {
    logger.error('Failed to notify unvisited assignments', { error: err.message, employeeId });
  }
}

module.exports = { markAssignmentVisited, notifyUnvisitedAssignments };
