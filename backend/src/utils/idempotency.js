/**
 * idempotency.js — dedupe for retried mutating requests.
 *
 * The mobile client (api.js) auto-retries requests that fail with 502/503/504
 * (a Render cold-start boot window) by resending the exact same request. If
 * the original attempt actually reached the server and completed — but the
 * success response was dropped before the client saw it — a naive retry
 * would perform the same write twice (a duplicate open visit, a double-
 * counted geofence breach, ...). The client attaches a stable
 * `Idempotency-Key` header that stays the same across retries of one logical
 * request; routes check it before mutating and replay the stored response
 * instead of repeating the write.
 */
const pool = require('../db/pool');
const logger = require('./logger');

// Scoped by employee_id, not just the key — the key is client-generated
// (not a server-issued secret), so without this an attacker who observed or
// guessed another employee's Idempotency-Key value could replay it under
// their own request and receive that employee's cached response.
//
// Also scoped by endpoint: `key` alone is the table's PRIMARY KEY, so if the
// same employee's client ever reused one Idempotency-Key value across two
// different mutating routes, a lookup that ignored `endpoint` would replay
// the FIRST route's cached response back to the SECOND route's caller
// instead of letting it perform its own write. Every caller must pass the
// same `endpoint` string here as it later passes to saveIdempotentResponse.
async function getIdempotentResponse(key, employeeId, endpoint) {
  if (!key) return null;
  const result = await pool.query(
    `SELECT response_status, response_body FROM idempotency_keys WHERE key = $1 AND employee_id = $2 AND endpoint = $3`,
    [key, employeeId, endpoint]
  );
  return result.rows[0] || null;
}

async function saveIdempotentResponse(key, employeeId, endpoint, status, body) {
  if (!key) return;
  await pool.query(
    `INSERT INTO idempotency_keys (key, employee_id, endpoint, response_status, response_body)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (key) DO NOTHING`,
    [key, employeeId, endpoint, status, body]
  );
}

// Retention: every mutating request with an Idempotency-Key header
// (mobile's cold-start retry, and every login/logout/location-check) inserts
// a permanent row here with nothing else ever deleting it — left running,
// this table grows without bound for the life of the deployment. A key only
// ever needs to survive long enough for the client's OWN retry window
// (COLD_START_RETRY_DELAYS_MS tops out well under a minute; the offline
// sync queue's bounded retries stretch to ~hours at the 30min-capped
// backoff) — 24h is a generous multiple of that with margin to spare.
const RETENTION_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

async function cleanupOldIdempotencyKeys() {
  try {
    await pool.query(`DELETE FROM idempotency_keys WHERE created_at < NOW() - INTERVAL '${RETENTION_MS} milliseconds'`);
  } catch (err) {
    logger.error('Failed to clean up old idempotency keys', { error: err.message });
  }
}

// unref() so this timer never keeps the process alive on its own (relevant
// for tests and clean shutdowns) — mirrors auth.middleware.js's own sweep.
const cleanupInterval = setInterval(cleanupOldIdempotencyKeys, CLEANUP_INTERVAL_MS);
cleanupInterval.unref();

module.exports = { getIdempotentResponse, saveIdempotentResponse, cleanupOldIdempotencyKeys };
