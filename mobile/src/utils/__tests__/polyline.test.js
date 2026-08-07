import { decodePolyline } from '../polyline';

describe('decodePolyline', () => {
  test('empty/invalid input returns an empty array', () => {
    expect(decodePolyline('')).toEqual([]);
    expect(decodePolyline(null)).toEqual([]);
    expect(decodePolyline(undefined)).toEqual([]);
  });

  test('decodes the canonical Google polyline algorithm example', () => {
    // From Google's own documentation of the encoding algorithm.
    const points = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(points).toHaveLength(3);
    expect(points[0].latitude).toBeCloseTo(38.5, 4);
    expect(points[0].longitude).toBeCloseTo(-120.2, 4);
    expect(points[1].latitude).toBeCloseTo(40.7, 4);
    expect(points[1].longitude).toBeCloseTo(-120.95, 4);
    expect(points[2].latitude).toBeCloseTo(43.252, 4);
    expect(points[2].longitude).toBeCloseTo(-126.453, 4);
  });
});
