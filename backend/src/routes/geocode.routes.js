/**
 * geocode.routes.js — proxies Google's Geocoding + Places APIs.
 *
 * GET /api/geocode/search?q=<address>   — forward geocode (address -> lat/lng),
 *   used by the Admin panel to look up a dealer's coordinates from its address.
 * GET /api/geocode/reverse?lat=&lng=    — reverse geocode (lat/lng -> address),
 *   used by the mobile app to show a readable address at login/logout.
 * GET /api/geocode/nearby?lat=&lng=&radius= — named places near a point, used
 *   by the Admin panel to let a manager snap the dealer pin onto a landmark.
 * GET /api/geocode/autocomplete?input=&sessiontoken= — live address suggestions
 *   as the manager types a dealer's address, Google-Maps-search-box style.
 * GET /api/geocode/place-details?place_id=&sessiontoken= — resolves a chosen
 *   autocomplete suggestion to actual lat/lng + formatted address.
 *
 * Proxied through our own backend (rather than called directly from phones or
 * browsers) so the Google Maps API key never leaves the server, and so one
 * shared in-memory cache covers every rep/manager instead of each client
 * hitting Google independently.
 */
const express = require('express');
const logger = require('../utils/logger');

const router = express.Router();

const GOOGLE_GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
// Places autocomplete/details/nearby use the newer "Places API (New)" family
// (places.googleapis.com/v1/...) rather than the legacy maps.googleapis.com
// place/* endpoints — a separate enablement in Google Cloud from Geocoding,
// and the one that matches a key provisioned with "Places UI Kit" scopes.
const PLACES_API_BASE = 'https://places.googleapis.com/v1';

// Simple in-memory cache — dealer addresses and login coordinates repeat
// constantly (same dealers, same day), so this avoids re-querying Google for
// something we already resolved a minute ago (and keeps API spend down).
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const cache = new Map();

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(key, value) {
  cache.set(key, { value, time: Date.now() });
}

const UPSTREAM_TIMEOUT_MS = 8000;

// Every Google Maps HTTP API replies 200 OK with its own `status` field even
// on failure (ZERO_RESULTS, REQUEST_DENIED, OVER_QUERY_LIMIT, ...) — HTTP
// status alone doesn't tell you whether the call actually succeeded.
async function googleFetch(baseUrl, params) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_MAPS_API_KEY is not configured');
  }
  const url = `${baseUrl}?${new URLSearchParams({ ...params, key: apiKey }).toString()}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Google Maps API responded ${response.status}`);
  }
  const data = await response.json();
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`Google Maps API status ${data.status}: ${data.error_message || 'no details'}`);
  }
  return data;
}

// Places API (New) uses POST + JSON bodies and an API-key header (rather
// than a `key` query param) and reports errors via normal HTTP status codes
// with a JSON body (rather than a 200 + internal `status` field), so it
// needs its own fetch helper distinct from googleFetch's legacy-API shape.
async function placesApiFetch(path, { method = 'GET', body, fieldMask } = {}) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_MAPS_API_KEY is not configured');
  }
  const headers = { 'X-Goog-Api-Key': apiKey };
  if (fieldMask) headers['X-Goog-FieldMask'] = fieldMask;
  if (body) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${PLACES_API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Places API error ${response.status}: ${data.error?.message || 'no details'}`);
  }
  return data;
}

// GET /api/geocode/search?q=<address>
router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) {
    return res.status(400).json({ error: 'q (address) is required' });
  }

  const cacheKey = `search:${q.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data = await googleFetch(GOOGLE_GEOCODE_URL, { address: q });

    if (!data.results || data.results.length === 0) {
      const empty = { found: false, candidates: [] };
      setCached(cacheKey, empty);
      return res.json(empty);
    }

    // Multiple candidates, not just the top hit — the same name can exist in
    // more than one city (e.g. "Fun Republic Mall" in both Coimbatore and
    // Lucknow), so picking blindly risks silently choosing the wrong one.
    const candidates = data.results.slice(0, 5).map((r) => ({
      latitude: r.geometry.location.lat,
      longitude: r.geometry.location.lng,
      display_name: r.formatted_address,
    }));
    const result = { found: true, candidates };
    setCached(cacheKey, result);
    return res.json(result);
  } catch (err) {
    logger.error('Geocode search error', { error: err.message, stack: err.stack });
    return res.status(502).json({ error: 'Geocoding service unavailable — you can still enter coordinates manually.' });
  }
});

// Maps Google's address_components (each { long_name, short_name, types[] })
// onto the flat field names the mobile app's formatAddressParts() expects,
// so switching providers here doesn't require any mobile-side change.
function extractRawAddress(components) {
  const byType = (type) => components.find((c) => c.types.includes(type))?.long_name || null;
  return {
    house_number: byType('street_number'),
    road: byType('route'),
    suburb: byType('sublocality') || byType('sublocality_level_1'),
    neighbourhood: byType('neighborhood'),
    city_district: byType('administrative_area_level_2'),
    city: byType('locality'),
    town: null,
    village: null,
    state: byType('administrative_area_level_1'),
    postcode: byType('postal_code'),
    country: byType('country'),
  };
}

// GET /api/geocode/reverse?lat=&lng=
router.get('/reverse', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'lat and lng must be valid numbers (-90..90, -180..180)' });
  }

  // Round to ~11m precision for the cache key — logins cluster tightly
  // around the same dealer/office location, so this collapses near-duplicate
  // lookups without meaningfully hurting address accuracy.
  const cacheKey = `reverse:${lat.toFixed(4)},${lng.toFixed(4)}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data = await googleFetch(GOOGLE_GEOCODE_URL, { latlng: `${lat},${lng}` });
    const top = data.results?.[0];

    const address = top?.formatted_address || `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    const raw = top?.address_components ? extractRawAddress(top.address_components) : null;
    const payload = { address, raw };
    setCached(cacheKey, payload);
    return res.json(payload);
  } catch (err) {
    logger.error('Geocode reverse error', { error: err.message, stack: err.stack });
    return res.status(502).json({ error: 'Geocoding service unavailable', address: `${lat.toFixed(5)}, ${lng.toFixed(5)}` });
  }
});

// GET /api/geocode/nearby?lat=&lng=&radius=
// Lets a manager jump the dealer pin onto a recognizable named place (shop,
// cafe, landmark) instead of hunting for an unlabeled building on the map.
router.get('/nearby', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const radius = Math.min(Math.max(parseInt(req.query.radius) || 150, 1), 500);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'lat and lng must be valid numbers (-90..90, -180..180)' });
  }

  const cacheKey = `nearby:${lat.toFixed(4)},${lng.toFixed(4)},${radius}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data = await placesApiFetch('/places:searchNearby', {
      method: 'POST',
      fieldMask: 'places.displayName,places.location,places.types',
      body: { maxResultCount: 20, locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } } },
    });

    const places = (data.places || [])
      .map((p) => ({
        name: p.displayName?.text,
        latitude: p.location?.latitude,
        longitude: p.location?.longitude,
        type: p.types?.[0] || 'place',
      }))
      .filter((p) => p.name && p.latitude != null && p.longitude != null)
      .slice(0, 30);

    const result = { places };
    setCached(cacheKey, result);
    return res.json(result);
  } catch (err) {
    logger.error('Geocode nearby error', { error: err.message, stack: err.stack });
    return res.status(502).json({ error: 'Nearby-places lookup unavailable', places: [] });
  }
});

// GET /api/geocode/autocomplete?input=<partial text>&sessiontoken=<uuid>
// Fires on close to every keystroke while typing a dealer address, so this
// deliberately doesn't cache (the input string is different on every call
// anyway) and treats an empty/short input as "no suggestions yet" rather
// than an error — the UI calls this continuously, not on an explicit submit.
router.get('/autocomplete', async (req, res) => {
  const input = (req.query.input || '').trim();
  if (input.length < 3) {
    return res.json({ predictions: [] });
  }

  try {
    const body = { input, includedRegionCodes: ['in'] };
    // Google bills a full autocomplete-then-details sequence as one cheaper
    // "session" when the same token is passed on every call in that sequence
    // — the frontend generates one per address search and discards it once a
    // suggestion is picked (or the field is abandoned).
    if (req.query.sessiontoken) body.sessionToken = req.query.sessiontoken;

    const data = await placesApiFetch('/places:autocomplete', { method: 'POST', body });
    const predictions = (data.suggestions || [])
      .filter((s) => s.placePrediction)
      .slice(0, 6)
      .map((s) => ({
        place_id: s.placePrediction.placeId,
        description: s.placePrediction.text?.text || '',
      }));
    return res.json({ predictions });
  } catch (err) {
    logger.error('Geocode autocomplete error', { error: err.message, stack: err.stack });
    return res.status(502).json({ error: 'Autocomplete unavailable', predictions: [] });
  }
});

// GET /api/geocode/place-details?place_id=<id>&sessiontoken=<uuid>
router.get('/place-details', async (req, res) => {
  const placeId = (req.query.place_id || '').trim();
  if (!placeId) {
    return res.status(400).json({ error: 'place_id is required' });
  }

  const cacheKey = `place-details:${placeId}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const qs = req.query.sessiontoken ? `?sessionToken=${encodeURIComponent(req.query.sessiontoken)}` : '';
    const data = await placesApiFetch(`/places/${encodeURIComponent(placeId)}${qs}`, {
      fieldMask: 'location,formattedAddress',
    });
    if (!data.location) {
      return res.status(502).json({ error: 'No location found for that place' });
    }

    const payload = {
      latitude: data.location.latitude,
      longitude: data.location.longitude,
      display_name: data.formattedAddress,
    };
    setCached(cacheKey, payload);
    return res.json(payload);
  } catch (err) {
    logger.error('Geocode place-details error', { error: err.message, stack: err.stack });
    return res.status(502).json({ error: 'Place lookup unavailable' });
  }
});

module.exports = router;
