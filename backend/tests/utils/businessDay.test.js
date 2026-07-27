const { businessDateExpr, isCurrentBusinessDay, DAY_BOUNDARY_HOUR } = require('../../src/utils/businessDay');

describe('businessDay', () => {
  test('DAY_BOUNDARY_HOUR defaults to 5 when unset/invalid', () => {
    expect(DAY_BOUNDARY_HOUR).toBe(5);
  });

  test('businessDateExpr shifts back by the boundary hour', () => {
    const expr = businessDateExpr('some_column');
    expect(expr).toBe(`DATE((some_column) AT TIME ZONE 'Asia/Kolkata' - INTERVAL '5 hours')`);
  });

  test('isCurrentBusinessDay compares both sides using the same shifted expression', () => {
    const cond = isCurrentBusinessDay('check_in_time');
    expect(cond).toContain('check_in_time');
    expect(cond).toContain('NOW()');
    expect(cond.split('=').length).toBe(2);
  });
});
