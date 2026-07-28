/**
 * geocode.routes.js — proxies Google's Geocoding + Places APIs.
 *
 * GET /api/geocode/search?q=<address>   — forward geocode (address -> lat/lng),
 *   used by the Admin panel to look up a dealer's coordinates from its address.
 * GET /api/geocode/reverse?lat=&lng=    — reverse geocode (lat/lng -> address),
 *   used by the mobile app to show a readable address at check-in/out.
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
const GOOGLE_PLACES_NEARBY_URL = 'https://maps.googleapis.com/maps/api/place/nearbysearch/json';
const GOOGLE_PLACES_AUTOCOMPLETE_URL = 'https://maps.googleapis.com/maps/api/place/autocomplete/json';
const GOOGLE_PLACES_DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';

// Simple in-memory cache — dealer addresses and check-in coordinates repeat
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
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({ error: 'lat and lng are required' });
  }

  // Round to ~11m precision for the cache key — check-ins cluster tightly
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
  const radius = Math.min(parseInt(req.query.radius) || 150, 500);
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({ error: 'lat and lng are required' });
  }

  const cacheKey = `nearby:${lat.toFixed(4)},${lng.toFixed(4)},${radius}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data = await googleFetch(GOOGLE_PLACES_NEARBY_URL, { location: `${lat},${lng}`, radius: String(radius) });

    const places = (data.results || [])
      .map((r) => ({
        name: r.name,
        latitude: r.geometry?.location?.lat,
        longitude: r.geometry?.location?.lng,
        type: r.types?.[0] || 'place',
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
    const params = { input, components: 'country:in' };
    // Google bills a full autocomplete-then-details sequence as one cheaper
    // "session" when the same token is passed on every call in that sequence
    // — the frontend generates one per address search and discards it once a
    // suggestion is picked (or the field is abandoned).
    if (req.query.sessiontoken) params.sessiontoken = req.query.sessiontoken;

    const data = await googleFetch(GOOGLE_PLACES_AUTOCOMPLETE_URL, params);
    const predictions = (data.predictions || []).slice(0, 6).map((p) => ({
      place_id: p.place_id,
      description: p.description,
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
    const params = { place_id: placeId, fields: 'geometry,formatted_address' };
    if (req.query.sessiontoken) params.sessiontoken = req.query.sessiontoken;

    const data = await googleFetch(GOOGLE_PLACES_DETAILS_URL, params);
    const location = data.result?.geometry?.location;
    if (!location) {
      return res.status(502).json({ error: 'No location found for that place' });
    }

    const payload = {
      latitude: location.lat,
      longitude: location.lng,
      display_name: data.result.formatted_address,
    };
    setCached(cacheKey, payload);
    return res.json(payload);
  } catch (err) {
    logger.error('Geocode place-details error', { error: err.message, stack: err.stack });
    return res.status(502).json({ error: 'Place lookup unavailable' });
  }
});

module.exports = router;
