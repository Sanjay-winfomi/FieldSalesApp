jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));

const pool = require('../../src/db/pool');
const { createManagerNotification } = require('../../src/utils/managerNotifications');

describe('createManagerNotification', () => {
  afterEach(() => jest.resetAllMocks());

  test('inserts business_date and guards it with an ON CONFLICT DO NOTHING for day_absent', async () => {
    pool.query.mockResolvedValueOnce({});

    await createManagerNotification({
      type: 'day_absent',
      title: 'Representative did not log in',
      body: 'divya did not log in on 18 Aug 2026',
      severity: 'danger',
      employeeId: 4,
      businessDate: '2026-08-18',
    });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('business_date');
    expect(sql).toContain("ON CONFLICT (employee_id, business_date) WHERE type = 'day_absent' DO NOTHING");
    expect(params).toEqual(['day_absent', 'Representative did not log in', 'divya did not log in on 18 Aug 2026', 'danger', 4, null, null, null, '2026-08-18']);
  });

  test('leaves business_date null for notification types with no business date concept', async () => {
    pool.query.mockResolvedValueOnce({});

    await createManagerNotification({
      type: 'left_dealer',
      title: 'Left dealer',
      body: 'rep left the dealer premises',
      employeeId: 4,
      dealerId: 9,
    });

    const [, params] = pool.query.mock.calls[0];
    expect(params[params.length - 1]).toBeNull();
  });

  test('swallows a DB error instead of throwing', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));

    await expect(createManagerNotification({ type: 'day_absent', title: 't', body: 'b' })).resolves.not.toThrow();
  });
});
