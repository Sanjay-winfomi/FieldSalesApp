import { describe, test, expect } from 'vitest';
import { render } from '@testing-library/react';
import { buildDynamicColumns, formatMinutesAsHours } from '../reports';

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

  test('a "_minutes" column renders as "Xh Ym" and drops "Minutes" from its header', () => {
    const rows = [{ name: 'Arun', total_duration_minutes: 835 }];
    const cols = buildDynamicColumns(rows);
    const durationCol = cols.find((c) => c.key === 'total_duration_minutes');
    expect(durationCol.label).toBe('Total Duration');
    const { container } = render(durationCol.render(rows[0]));
    expect(container.textContent).toBe('13h 55m');
  });
});

describe('formatMinutesAsHours', () => {
  test('formats whole hours and leftover minutes as "Xh Ym"', () => {
    expect(formatMinutesAsHours(835)).toBe('13h 55m');
    expect(formatMinutesAsHours(60)).toBe('1h 0m');
    expect(formatMinutesAsHours(14836)).toBe('247h 16m');
  });

  test('formats less than a minute as "0h 0m"', () => {
    expect(formatMinutesAsHours(0)).toBe('0h 0m');
  });

  test('returns an em dash for null/non-numeric input', () => {
    expect(formatMinutesAsHours(null)).toBe('—');
    expect(formatMinutesAsHours(undefined)).toBe('—');
  });
});
