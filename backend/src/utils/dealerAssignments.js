/**
 * dealerAssignments.js — small helpers shared between assignments.routes.js,
 * navigation.routes.js, and the one non-blocking hook into the existing
 * dealer check-in flow (visits.routes.js).
 */
const logger = require('./logger');
const pool = require('../db/pool');
const { businessDateExpr } = require('./businessDay');

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

module.exports = { markAssignmentVisited };
