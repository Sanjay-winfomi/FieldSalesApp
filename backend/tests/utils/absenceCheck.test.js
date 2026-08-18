jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));
jest.mock('../../src/utils/managerNotifications', () => ({ createManagerNotification: jest.fn() }));

const pool = require('../../src/db/pool');
const { createManagerNotification } = require('../../src/utils/managerNotifications');
const { runAbsenceCheckSweep } = require('../../src/utils/absenceCheck');

describe('runAbsenceCheckSweep', () => {
  afterEach(() => jest.resetAllMocks());

  test('notifies the manager for a rep with no attendance row past their business date\'s 11pm cutoff', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ employee_id: 4, username: 'divya', business_date: '2026-08-18' }],
    });

    await runAbsenceCheckSweep();

    expect(createManagerNotification).toHaveBeenCalledWith(expect.objectContaining({
      type: 'day_absent',
      severity: 'danger',
      employeeId: 4,
    }));
    expect(createManagerNotification.mock.calls[0][0].body).toContain('divya');
  });

  test('notifies once per employee per business date returned by the query', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        { employee_id: 4, username: 'divya', business_date: '2026-08-18' },
        { employee_id: 6, username: 'arun', business_date: '2026-08-17' },
      ],
    });

    await runAbsenceCheckSweep();

    expect(createManagerNotification).toHaveBeenCalledTimes(2);
  });

  test('does nothing when no rep is eligible (everyone logged in, or already notified)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await runAbsenceCheckSweep();

    expect(createManagerNotification).not.toHaveBeenCalled();
  });

  test('does not throw if the sweep itself fails', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));
    await expect(runAbsenceCheckSweep()).resolves.not.toThrow();
  });

  test('one failed notification does not stop the rest from being sent', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        { employee_id: 4, username: 'divya', business_date: '2026-08-18' },
        { employee_id: 6, username: 'arun', business_date: '2026-08-18' },
      ],
    });
    createManagerNotification
      .mockRejectedValueOnce(new Error('notification service down'))
      .mockResolvedValueOnce();

    await runAbsenceCheckSweep();

    expect(createManagerNotification).toHaveBeenCalledTimes(2);
  });
});
