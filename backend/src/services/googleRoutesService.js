/**
 * googleRoutesService.js — thin client for Google Routes API (Compute
 * Routes Pro tier: traffic-aware duration + distance + polyline for a
 * single origin -> destination pair).
 *
 * Deliberately does NOT call Route Optimization / Fleet Routing — this
 * feature never reorders a rep's assigned dealer sequence, so there is
 * never more than one destination to route to at a time.
 *
 * Same auth shape as geocode.routes.js's placesApiFetch (POST + JSON body,
 * X-Goog-Api-Key header, X-Goog-FieldMask), reusing the same
 * GOOGLE_MAPS_API_KEY env var — no new secret. Adds one thing that pattern
 * doesn't have: a small bounded retry, since nothing in this backend
 * retries outbound Google calls today.
 */
const ROUTES_API_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const UPSTREAM_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;

const FIELD_MASK = [
  'routes.duration',
  'routes.staticDuration',
  'routes.distanceMeters',
  'routes.polyline.encodedPolyline',
  'routes.travelAdvisory',
].join(',');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A dropped connection/timeout, a 5xx, or a 429 (rate limit) are all worth
// one retry — anything else (bad request, auth failure, no route found) is
// not going to succeed on a second attempt.
function isRetryable(err) {
  return err.retryable === true;
}

async function computeRouteOnce({ originLat, originLng, destLat, destLng }) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_MAPS_API_KEY is not configured');
  }

  const body = {
    origin: { location: { latLng: { latitude: originLat, longitude: originLng } } },
    destination: { location: { latLng: { latitude: destLat, longitude: destLng } } },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
    computeAlternativeRoutes: false,
    units: 'METRIC',
    languageCode: 'en-US',
  };

  let response;
  try {
    response = await fetch(ROUTES_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    // Network error / timeout — worth a retry.
    const wrapped = new Error(`Routes API request failed: ${err.message}`);
    wrapped.retryable = true;
    throw wrapped;
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const err = new Error(`Routes API error ${response.status}: ${data.error?.message || 'no details'}`);
    err.retryable = response.status === 429 || response.status >= 500;
    throw err;
  }

  const route = data.routes?.[0];
  if (!route) {
    const err = new Error('Routes API returned no route for this origin/destination');
    err.retryable = false;
    throw err;
  }

  return {
    distanceMeters: route.distanceMeters ?? null,
    // route.duration is traffic-aware ("live" ETA); staticDuration ignores
    // current traffic — together they let the caller show a traffic delay.
    durationSeconds: parseGoogleDuration(route.duration),
    durationInTrafficSeconds: parseGoogleDuration(route.duration),
    staticDurationSeconds: parseGoogleDuration(route.staticDuration),
    encodedPolyline: route.polyline?.encodedPolyline || null,
  };
}

// Google's Duration fields render as e.g. "1234s" (a string, not a number).
function parseGoogleDuration(value) {
  if (typeof value !== 'string') return null;
  const seconds = parseInt(value.replace('s', ''), 10);
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * @param {object} opts
 * @param {number} opts.originLat
 * @param {number} opts.originLng
 * @param {number} opts.destLat
 * @param {number} opts.destLng
 * @returns {Promise<{distanceMeters: number|null, durationSeconds: number|null,
 *   durationInTrafficSeconds: number|null, staticDurationSeconds: number|null,
 *   encodedPolyline: string|null}>}
 */
async function computeRoute(opts) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await computeRouteOnce(opts);
    } catch (err) {
      lastError = err;
      if (attempt < MAX_ATTEMPTS && isRetryable(err)) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

module.exports = { computeRoute };
