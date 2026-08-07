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

// Scoped by employee_id, not just the key — the key is client-generated
// (not a server-issued secret), so without this an attacker who observed or
// guessed another employee's Idempotency-Key value could replay it under
// their own request and receive that employee's cached response.
async function getIdempotentResponse(key, employeeId) {
  if (!key) return null;
  const result = await pool.query(
    `SELECT response_status, response_body FROM idempotency_keys WHERE key = $1 AND employee_id = $2`,
    [key, employeeId]
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

module.exports = { getIdempotentResponse, saveIdempotentResponse };
