/**
 * crashReporter.js — local-only error reporting.
 *
 * This used to report to Sentry, but no DSN was ever wired in (the
 * project's Sentry trial ended without one being configured), so nothing
 * was ever actually being sent off-device. Sentry has been removed
 * entirely; this now just logs locally. Every call site that reports a
 * caught error (ErrorBoundary, AppState listeners, background task
 * callbacks) still calls captureException() exactly as before — only this
 * module's internals changed, so none of those call sites needed touching.
 */
let initialized = false;

/**
 * Call once, as early as possible (index.js, before anything else runs).
 */
export function initCrashReporter() {
  initialized = true;
}

/**
 * Reports a caught error. Safe to call even if initCrashReporter() was
 * never called.
 * @param {Error} error
 * @param {object} [context] - e.g. { area: 'appstate-listener' }
 */
export function captureException(error, context) {
  console.error('[crashReporter]', error, context || '');
}

export function isInitialized() {
  return initialized;
}
