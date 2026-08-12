/**
 * geo.js — straight-line (great-circle) distance helper, mirroring
 * backend/src/utils/haversine.js and mobile/src/services/location.js's
 * haversineMeters. Used for a quick "as the crow flies" distance estimate
 * in the UI (e.g. between consecutive dealers in a manager's Visit Plan) —
 * NOT a substitute for the Google Routes API's actual driving
 * distance/duration, which accounts for roads and traffic.
 */
const EARTH_RADIUS_KM = 6371;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * @returns {number} distance in kilometres between two lat/lng points.
 */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.asin(Math.sqrt(a));
}
