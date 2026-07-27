/**
 * haversine.js — mirrors backend/src/utils/haversine.js so the periodic
 * in-visit location check (visitMonitor.js) can evaluate "still inside the
 * dealer's radius?" locally, without a network round-trip every interval.
 */
const EARTH_RADIUS_KM = 6371;

export function haversineKm(lat1, lng1, lat2, lng2) {
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

export function isWithinRadius(lat1, lng1, lat2, lng2, radiusMeters) {
  return haversineKm(lat1, lng1, lat2, lng2) * 1000 <= radiusMeters;
}
