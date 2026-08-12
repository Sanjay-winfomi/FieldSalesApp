import { describe, test, expect } from 'vitest';
import { haversineKm } from '../geo';

describe('haversineKm', () => {
  test('returns 0 for identical points', () => {
    expect(haversineKm(11.0, 77.0, 11.0, 77.0)).toBe(0);
  });

  test('matches a known distance within a small tolerance', () => {
    // Coimbatore RS Puram (11.0098, 76.9558) to Peelamedu (11.0234, 77.0012) — ~5km apart.
    const km = haversineKm(11.0098, 76.9558, 11.0234, 77.0012);
    expect(km).toBeGreaterThan(4);
    expect(km).toBeLessThan(6);
  });
});
