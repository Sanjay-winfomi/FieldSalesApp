/**
 * polyline.js — decoder for Google's encoded polyline format
 * (https://developers.google.com/maps/documentation/utilities/polylinealgorithm),
 * as returned by the Routes API's routes.polyline.encodedPolyline field.
 * No third-party dependency needed — this is the well-known ~20-line algorithm.
 */

/**
 * @param {string} encoded
 * @returns {Array<{latitude: number, longitude: number}>}
 */
export function decodePolyline(encoded) {
  if (typeof encoded !== 'string' || encoded.length === 0) return [];

  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 1;
    let shift = 0;
    let b;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 1;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }

  return points;
}
