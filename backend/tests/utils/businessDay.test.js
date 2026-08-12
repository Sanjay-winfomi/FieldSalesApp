const { businessDateExpr, isCurrentBusinessDay, DAY_BOUNDARY_HOUR, getBusinessDateString } = require('../../src/utils/businessDay');

describe('businessDay', () => {
  test('DAY_BOUNDARY_HOUR defaults to 5 when unset/invalid', () => {
    expect(DAY_BOUNDARY_HOUR).toBe(5);
  });

  test('businessDateExpr shifts back by the boundary hour', () => {
    const expr = businessDateExpr('some_column');
    expect(expr).toBe(`DATE((some_column) AT TIME ZONE 'Asia/Kolkata' - INTERVAL '5 hours')`);
  });

  test('isCurrentBusinessDay compares both sides using the same shifted expression', () => {
    const cond = isCurrentBusinessDay('login_time');
    expect(cond).toContain('login_time');
    expect(cond).toContain('NOW()');
    expect(cond.split('=').length).toBe(2);
  });
});

describe('getBusinessDateString', () => {
  test('during the daytime bucket, matches the plain IST calendar date', () => {
    // 2026-08-10 10:00 UTC = 2026-08-10 15:30 IST — well past the 5am
    // boundary, and no UTC/IST calendar-date crossing involved either.
    const now = new Date('2026-08-10T10:00:00Z');
    expect(getBusinessDateString(now)).toBe('2026-08-10');
  });

  test('just after IST midnight but before the boundary hour, still counts as the previous business day', () => {
    // 2026-08-10 19:00 UTC = 2026-08-11 00:30 IST — past IST midnight, but
    // before the 5am boundary, so business date is still Aug 10.
    const now = new Date('2026-08-10T19:00:00Z');
    expect(getBusinessDateString(now)).toBe('2026-08-10');
  });

  test('rolls over to the next business day right at the 5am IST boundary — even though the UTC calendar date has not', () => {
    // 2026-08-10 23:45 UTC = 2026-08-11 05:15 IST — past the boundary, so
    // the business day has already rolled to Aug 11, even though the UTC
    // calendar date (what a naive `toISOString().slice(0, 10)` would give)
    // is still Aug 10. This is exactly the drift getBusinessDateString exists
    // to avoid.
    const now = new Date('2026-08-10T23:45:00Z');
    expect(getBusinessDateString(now)).toBe('2026-08-11');
    expect(now.toISOString().slice(0, 10)).toBe('2026-08-10'); // the drift, for contrast
  });

  test('defaults to the current time when no argument is given', () => {
    expect(getBusinessDateString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
