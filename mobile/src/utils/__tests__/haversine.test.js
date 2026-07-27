import { haversineKm, isWithinRadius } from '../haversine';

describe('haversineKm', () => {
  test('same point returns 0', () => {
    expect(haversineKm(11.0168, 76.9558, 11.0168, 76.9558)).toBe(0);
  });

  test('~1 km apart', () => {
    const dist = haversineKm(11.0168, 76.9558, 11.0258, 76.9558);
    expect(dist).toBeGreaterThan(0.95);
    expect(dist).toBeLessThan(1.05);
  });
});

describe('isWithinRadius', () => {
  test('true when inside the radius', () => {
    expect(isWithinRadius(11.0168, 76.9558, 11.01685, 76.9559, 100)).toBe(true);
  });

  test('false when outside the radius', () => {
    expect(isWithinRadius(11.0168, 76.9558, 11.0258, 76.9558, 100)).toBe(false);
  });
});
