import { describe, test, expect } from 'vitest';
import { render } from '@testing-library/react';
import { buildDynamicColumns, formatMinutesAsHours, formatCellValue } from '../reports';

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

  test('a bare "YYYY-MM-DD" date column renders as "DD-MM-YYYY"', () => {
    const rows = [{ name: 'Arun', absence_date: '2026-08-18' }];
    const cols = buildDynamicColumns(rows);
    const dateCol = cols.find((c) => c.key === 'absence_date');
    const { container } = render(dateCol.render(rows[0]));
    expect(container.textContent).toBe('18-08-2026');
  });
});

describe('formatCellValue', () => {
  test('formats a bare date-only string as DD-MM-YYYY', () => {
    expect(formatCellValue('2026-08-18')).toBe('18-08-2026');
    expect(formatCellValue('2026-01-05')).toBe('05-01-2026');
  });

  test('still formats a full ISO timestamp as a date+time, not just DD-MM-YYYY', () => {
    // Regression check: the new bare-date pattern is exact-length-anchored
    // ($) so it must never match a timestamp and truncate off the time.
    expect(formatCellValue('2026-08-18T05:00:00.000Z')).not.toBe('18-08-2026');
  });

  test('other string values pass through unchanged', () => {
    expect(formatCellValue('Arun Kumar')).toBe('Arun Kumar');
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
