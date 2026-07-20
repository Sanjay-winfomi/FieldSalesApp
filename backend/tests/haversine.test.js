/**
 * haversine.test.js — Unit tests for the Haversine distance utility.
 * Run: npm test
 *
 * Test pairs chosen with known distances from authoritative calculators
 * (e.g. https://www.movable-type.co.uk/scripts/latlong.html)
 */
const { haversineKm, isWithinRadius } = require('../src/utils/haversine');

describe('haversineKm', () => {
  test('same point returns 0', () => {
    expect(haversineKm(11.0168, 76.9558, 11.0168, 76.9558)).toBe(0);
  });

  test('~1 km apart (Gandhipuram to ~1 km north)', () => {
    // Moving ~0.009 degrees latitude ≈ 1 km
    const dist = haversineKm(11.0168, 76.9558, 11.0258, 76.9558);
    expect(dist).toBeGreaterThan(0.95);
    expect(dist).toBeLessThan(1.05);
  });

  test('~5 km apart (RS Puram to Peelamedu, Coimbatore)', () => {
    // Sri Balaji Hardware (RS Puram) to Anand Tiles (Peelamedu)
    const dist = haversineKm(11.0098, 76.9558, 11.0234, 77.0012);
    expect(dist).toBeGreaterThan(4.0);
    expect(dist).toBeLessThan(6.0);
  });

  test('~10–13 km apart (approximate Coimbatore cross-town)', () => {
    // These two coords are ~12.6 km apart — verified against haversine calculator
    const dist = haversineKm(11.0000, 76.9500, 11.0900, 77.0200);
    expect(dist).toBeGreaterThan(10.0);
    expect(dist).toBeLessThan(14.0);
  });

  test('known distance: London to Paris ≈ 341 km', () => {
    const dist = haversineKm(51.5074, -0.1278, 48.8566, 2.3522);
    expect(dist).toBeGreaterThan(335);
    expect(dist).toBeLessThan(347);
  });

  test('known distance: NYC to LA ≈ 3940 km', () => {
    const dist = haversineKm(40.7128, -74.006, 34.0522, -118.2437);
    expect(dist).toBeGreaterThan(3900);
    expect(dist).toBeLessThan(4000);
  });
});

describe('isWithinRadius', () => {
  test('returns true when point is inside the radius', () => {
    // ~50 m apart (< 100 m radius)
    const inRadius = isWithinRadius(11.0168, 76.9558, 11.01685, 76.9559, 100);
    expect(inRadius).toBe(true);
  });

  test('returns false when point is outside the radius', () => {
    // ~1 km apart (> 100 m radius)
    const outRadius = isWithinRadius(11.0168, 76.9558, 11.0258, 76.9558, 100);
    expect(outRadius).toBe(false);
  });

  test('exact boundary — just inside', () => {
    // ~99 m north of a point at 11°N — should be within 100 m
    // 1 degree latitude ≈ 111,139 m → 99 m ≈ 0.000891 degrees
    const inRadius = isWithinRadius(11.0, 77.0, 11.000891, 77.0, 100);
    expect(inRadius).toBe(true);
  });
});
