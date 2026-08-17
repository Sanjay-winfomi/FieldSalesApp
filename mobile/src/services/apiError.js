/**
 * apiError.js — extracts a user-facing message from a failed api.* call.
 *
 * Error responses carry both a machine-readable `error` code (e.g.
 * 'route_computation_failed') and, where there's one worth showing, a
 * human-readable `message` (e.g. 'Request timed out — Retry'). Always prefer
 * the message so reps see the friendly text instead of the raw code.
 */
export function getErrorMessage(error, fallback) {
  return error.response?.data?.message || error.response?.data?.error || fallback;
}
