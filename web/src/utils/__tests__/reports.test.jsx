import { describe, test, expect } from 'vitest';
import { buildDynamicColumns } from '../reports';

describe('buildDynamicColumns', () => {
  test('builds columns from a uniform row set', () => {
    const rows = [{ name: 'Arun', distance_km: 4.2 }];
    const cols = buildDynamicColumns(rows);
    expect(cols.map((c) => c.key)).toEqual(['name', 'distance_km']);
  });

  test('unions keys across all rows, not just the first, for a heterogeneous report', () => {
    const rows = [
      { name: 'Arun', distance_km: 4.2 },
      { name: 'Divya', distance_km: 2.1, exception_reason: 'Outside radius' },
    ];
    const cols = buildDynamicColumns(rows);
    expect(cols.map((c) => c.key)).toEqual(['name', 'distance_km', 'exception_reason']);
  });

  test('returns an empty column set for no rows', () => {
    expect(buildDynamicColumns([])).toEqual([]);
  });
});
