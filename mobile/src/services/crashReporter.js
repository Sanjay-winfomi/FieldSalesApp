import * as Sentry from '@sentry/react-native';

// Field names anywhere in an event's breadcrumb/context/extra data that are
// dropped entirely rather than sent, on the assumption that "safe unless
// proven otherwise" is the wrong default for a rep-tracking app — precise
// GPS coordinates and who/where they belong to are exactly what a crash
// reporter doesn't need to do its job (find and fix a bug), so there's no
// upside to sending them, only downside if this project's Sentry account
// is ever accessed by someone who shouldn't see where a specific rep was.
const SENSITIVE_KEYS = [
  'lat', 'lng', 'latitude', 'longitude', 'accuracy_meters', 'accuracymeters',
  'login_lat', 'login_lng', 'logout_lat', 'logout_lng',
  'dealer_lat', 'dealer_lng', 'dealer_name', 'dealer_address',
  'name', 'username', 'employee_name', 'address', 'reason',
];

// Catches PII embedded in free-text strings (error messages, breadcrumb
// messages) that no key-based scrub can catch — e.g. "GPS fix 12.9716,77.5946"
// logged inline in a warning message rather than as structured data.
const COORDINATE_PATTERN = /-?\d{1,3}\.\d{3,}/g;

function scrubString(value) {
  if (typeof value !== 'string') return value;
  return value.replace(COORDINATE_PATTERN, '[coord]');
}

function scrubObject(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 5) return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.includes(key.toLowerCase())) {
      out[key] = '[redacted]';
    } else if (typeof value === 'string') {
      out[key] = scrubString(value);
    } else if (value && typeof value === 'object') {
      out[key] = scrubObject(value, depth + 1);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function scrubEvent(event) {
  // Never send an identified user — see SENSITIVE_KEYS comment above.
  if (event.user) delete event.user;

  if (event.message) event.message = scrubString(event.message);

  if (event.exception?.values) {
    event.exception.values = event.exception.values.map((v) => ({
      ...v,
      value: scrubString(v.value),
    }));
  }

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((b) => ({
      ...b,
      message: scrubString(b.message),
      data: scrubObject(b.data),
    }));
  }

  if (event.extra) event.extra = scrubObject(event.extra);
  if (event.contexts) event.contexts = scrubObject(event.contexts);

  return event;
}

let initialized = false;

/**
 * Call once, as early as possible (index.js, before anything else runs) —
 * see index.js's own comment on why App/geofenceTask are require()'d after
 * the ErrorUtils handler is installed; this must run before those too, so
 * even a startup-time crash is reported.
 *
 * No-ops (logs a warning, doesn't throw) if EXPO_PUBLIC_SENTRY_DSN isn't
 * set — this repo ships without a real DSN configured; set one in EAS
 * environment variables to actually start receiving reports.
 */
export function initCrashReporter() {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  if (!dsn) {
    console.warn('Crash reporter not initialized: EXPO_PUBLIC_SENTRY_DSN is not set.');
    return;
  }
  Sentry.init({
    dsn,
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => ({
      ...breadcrumb,
      message: scrubString(breadcrumb.message),
      data: scrubObject(breadcrumb.data),
    }),
    // Never resolve device/network identity to a real person — reduces
    // what's collected in the first place, on top of beforeSend's scrub.
    sendDefaultPii: false,
  });
  initialized = true;
}

/**
 * Reports a caught error. Safe to call even if initCrashReporter() was
 * never called or no-opped (DSN missing) — Sentry.captureException is a
 * no-op in that case, not a throw.
 * @param {Error} error
 * @param {object} [context] - non-PII context (e.g. { area: 'appstate-listener' })
 */
export function captureException(error, context) {
  try {
    Sentry.captureException(error, context ? { extra: scrubObject(context) } : undefined);
  } catch (reportingError) {
    // The crash reporter itself must never be the thing that crashes.
    console.warn('Failed to report exception to crash reporter:', reportingError.message);
  }
}

export const __testing = { scrubEvent, scrubObject, scrubString };
export function isInitialized() {
  return initialized;
}
