jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));
jest.mock('../../src/utils/managerNotifications', () => ({ createManagerNotification: jest.fn() }));

const pool = require('../../src/db/pool');
const { createManagerNotification } = require('../../src/utils/managerNotifications');
const { runAutoCutoffSweep } = require('../../src/utils/autoCutoff');

describe('runAutoCutoffSweep', () => {
  afterEach(() => jest.resetAllMocks());

  test('closes an open dealer visit past the 1am cutoff and notifies the manager', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 10, attendance_id: 5, dealer_id: 3, visit_duration_minutes: 480 }] }) // UPDATE client_visits
      .mockResolvedValueOnce({ rows: [{ employee_id: 1, username: 'arun', dealer_name: 'Dealer A' }] }) // employee/dealer lookup
      .mockResolvedValueOnce({ rows: [] }); // UPDATE attendance — none open

    await runAutoCutoffSweep();

    expect(createManagerNotification).toHaveBeenCalledWith(expect.objectContaining({
      type: 'visit_auto_cutoff',
      employeeId: 1,
      dealerId: 3,
      visitId: 10,
    }));
    expect(createManagerNotification.mock.calls[0][0].body).toContain('arun');
    expect(createManagerNotification.mock.calls[0][0].body).toContain('Dealer A');
    expect(createManagerNotification.mock.calls[0][0].body).toContain('8.0h');
  });

  test('closes an open day (attendance) past the 1am cutoff and notifies the manager', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // UPDATE client_visits — none open
      .mockResolvedValueOnce({ rows: [{ id: 7, employee_id: 2, total_duration_minutes: 600 }] }) // UPDATE attendance
      .mockResolvedValueOnce({ rows: [{ username: 'priya' }] }); // employee lookup

    await runAutoCutoffSweep();

    expect(createManagerNotification).toHaveBeenCalledWith(expect.objectContaining({
      type: 'day_auto_cutoff',
      employeeId: 2,
    }));
    expect(createManagerNotification.mock.calls[0][0].body).toContain('priya');
    expect(createManagerNotification.mock.calls[0][0].body).toContain('10.0h');
  });

  test('does nothing when nothing is open past cutoff', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await runAutoCutoffSweep();

    expect(createManagerNotification).not.toHaveBeenCalled();
  });

  test('does not throw if the sweep itself fails', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));
    await expect(runAutoCutoffSweep()).resolves.not.toThrow();
  });
});
