/**
 * activityLog.js — structured logging for the four core check-in/check-out
 * flows, distinct from logger.error (failures only), so they're easy to
 * filter for in the combined log or an APM without string-matching emoji.
 */
const logger = require('./logger');

function logDayCheckIn(username, lat, lng) {
  logger.info('day_check_in', { username, lat, lng });
}

function logDayCheckOut(username, durationMins, distanceKm) {
  logger.info('day_check_out', { username, durationMins, distanceKm: parseFloat(distanceKm || 0) });
}

function logDealerCheckIn(username, dealerName) {
  logger.info('dealer_check_in', { username, dealerName });
}

function logDealerCheckOut(username, dealerName, durationMins, outOfRadius) {
  logger.info('dealer_check_out', { username, dealerName, durationMins, outOfRadius: !!outOfRadius });
}

function logVisitInterrupted(username, dealerName, distanceMeters) {
  logger.warn('visit_interrupted', { username, dealerName, distanceMeters });
}

module.exports = { logDayCheckIn, logDayCheckOut, logDealerCheckIn, logDealerCheckOut, logVisitInterrupted };
