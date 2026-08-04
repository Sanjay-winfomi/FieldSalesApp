/**
 * activityLog.js — structured logging for the four core login/logout
 * flows, distinct from logger.error (failures only), so they're easy to
 * filter for in the combined log or an APM without string-matching emoji.
 */
const logger = require('./logger');

function logDayLogin(username, lat, lng) {
  logger.info('day_login', { username, lat, lng });
}

function logDayLogout(username, durationMins, distanceKm) {
  logger.info('day_logout', { username, durationMins, distanceKm: parseFloat(distanceKm || 0) });
}

function logDealerLogin(username, dealerName) {
  logger.info('dealer_login', { username, dealerName });
}

function logDealerLogout(username, dealerName, durationMins, outOfRadius) {
  logger.info('dealer_logout', { username, dealerName, durationMins, outOfRadius: !!outOfRadius });
}

function logVisitInterrupted(username, dealerName, distanceMeters) {
  logger.warn('visit_interrupted', { username, dealerName, distanceMeters });
}

module.exports = { logDayLogin, logDayLogout, logDealerLogin, logDealerLogout, logVisitInterrupted };
