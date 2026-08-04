/**
 * haversine.js — Standalone, unit-tested Haversine distance calculator.
 *
 * Returns the great-circle distance in kilometres between two lat/lng points.
 * Used in 3 places:
 *   1. POST /api/visits/login   → distance_from_previous_km
 *   2. POST /api/visits/logout  → out_of_radius check vs dealer lat/lng
 *   3. POST /api/attendance/logout → total_distance_km accumulation
 */

const EARTH_RADIUS_KM = 6371;

/**
 * @param {number} lat1 - Latitude of point A (degrees)
 * @param {number} lng1 - Longitude of point A (degrees)
 * @param {number} lat2 - Latitude of point B (degrees)
 * @param {number} lng2 - Longitude of point B (degrees)
 * @returns {number} Distance in kilometres
 */
function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

/**
 * Returns true if point (lat2, lng2) is within `radiusMeters` of (lat1, lng1).
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @param {number} radiusMeters
 * @returns {boolean}
 */
function isWithinRadius(lat1, lng1, lat2, lng2, radiusMeters) {
  const distKm = haversineKm(lat1, lng1, lat2, lng2);
  return distKm * 1000 <= radiusMeters;
}

module.exports = { haversineKm, isWithinRadius };
