/**
 * managerNotifications.js — writes to the manager_notifications table that
 * backs the web dashboard's notification bell.
 *
 * There is no push-notification infrastructure in this app (no Expo push
 * tokens, no web-push/PWA scaffolding) — managers are web-dashboard-only, so
 * "notifying" them means writing a row here for the bell/unread-count to
 * pick up on its next poll, not delivering an OS-level push.
 */
const logger = require('./logger');
const pool = require('../db/pool');

/**
 * @param {object} opts
 * @param {string} opts.type - e.g. 'left_dealer', 'still_outside', 'returned',
 *   'login_exception', 'logout_exception', 'needs_verification'
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {'info'|'warning'|'danger'} [opts.severity]
 * @param {number} [opts.employeeId] - the rep the notification is about
 * @param {number} [opts.dealerId]
 * @param {number} [opts.visitId]
 * @param {number} [opts.followupRequestId] - lets the notification feed
 *   render Approve/Reject actions inline (see dealer_followup_requests)
 * @param {string} [opts.businessDate] - 'YYYY-MM-DD'; only meaningful for
 *   type 'day_absent' (see absenceCheck.js) — a partial unique index on
 *   (employee_id, business_date) WHERE type = 'day_absent' rejects a second
 *   insert for the same rep + day outright, so a sweep racing against
 *   another instance of itself can't double-notify (schema.sql). Every
 *   other type leaves this null and is unaffected by that index.
 */
async function createManagerNotification({ type, title, body, severity = 'info', employeeId = null, dealerId = null, visitId = null, followupRequestId = null, businessDate = null }) {
  try {
    await pool.query(
      `INSERT INTO manager_notifications (type, title, body, severity, employee_id, dealer_id, visit_id, followup_request_id, business_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (employee_id, business_date) WHERE type = 'day_absent' DO NOTHING`,
      [type, title, body, severity, employeeId, dealerId, visitId, followupRequestId, businessDate]
    );
  } catch (err) {
    // A notification failing to write should never take down the request
    // that triggered it (a location-check ping, a login/logout) — log and
    // move on rather than propagating.
    logger.error('Failed to create manager notification', { error: err.message, type });
  }
}

module.exports = { createManagerNotification };
