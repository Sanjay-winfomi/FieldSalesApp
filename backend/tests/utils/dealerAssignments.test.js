jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));
const pool = require('../../src/db/pool');
const { markAssignmentVisited, notifyUnvisitedAssignments } = require('../../src/utils/dealerAssignments');

describe('markAssignmentVisited', () => {
  afterEach(() => jest.clearAllMocks());

  test('completes the assignment and closes out its open navigation row', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 20 }] }) // assignment UPDATE ... RETURNING id
      .mockResolvedValueOnce({ rows: [] }); // navigation UPDATE

    await markAssignmentVisited({ employeeId: 1, dealerId: 5 });

    expect(pool.query).toHaveBeenCalledTimes(2);
    expect(pool.query.mock.calls[0][0]).toMatch(/UPDATE dealer_assignments/);
    expect(pool.query.mock.calls[1][0]).toMatch(/UPDATE dealer_navigations/);
    expect(pool.query.mock.calls[1][0]).toMatch(/status IN \('navigating', 'arrived'\)/);
    expect(pool.query.mock.calls[1][1]).toEqual([20]);
  });

  test('does nothing further when the dealer has no assignment for today', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // no matching assignment row

    await markAssignmentVisited({ employeeId: 1, dealerId: 5 });

    expect(pool.query).toHaveBeenCalledTimes(1); // no navigation UPDATE attempted
  });

  test('never throws when the database call fails', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));

    await expect(markAssignmentVisited({ employeeId: 1, dealerId: 5 })).resolves.toBeUndefined();
  });
});

describe('notifyUnvisitedAssignments', () => {
  afterEach(() => jest.clearAllMocks());

  test('does nothing when every assigned dealer was completed or cancelled', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // no unvisited dealers

    await notifyUnvisitedAssignments({ employeeId: 1 });

    expect(pool.query).toHaveBeenCalledTimes(1); // no username lookup, no notification insert
  });

  test('notifies managers, naming the one dealer, when exactly one was not visited', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ dealer_name: 'LuLu Hypermarket' }] })
      .mockResolvedValueOnce({ rows: [{ username: 'arun' }] })
      .mockResolvedValueOnce({ rows: [] }); // createManagerNotification's INSERT

    await notifyUnvisitedAssignments({ employeeId: 1 });

    expect(pool.query).toHaveBeenCalledTimes(3);
    const insertCall = pool.query.mock.calls[2];
    expect(insertCall[0]).toMatch(/INSERT INTO manager_notifications/);
    expect(insertCall[1][0]).toBe('unvisited_assignments');
    expect(insertCall[1][2]).toBe("arun ended the day without visiting LuLu Hypermarket.");
    expect(insertCall[1][4]).toBe(1);
  });

  test('lists every dealer by name when more than one was not visited', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ dealer_name: 'Boomerang' }, { dealer_name: 'Brookfields Mall' }] })
      .mockResolvedValueOnce({ rows: [{ username: 'arun' }] })
      .mockResolvedValueOnce({ rows: [] });

    await notifyUnvisitedAssignments({ employeeId: 1 });

    const insertCall = pool.query.mock.calls[2];
    expect(insertCall[1][2]).toBe(
      'arun ended the day without visiting 2 assigned dealers: Boomerang, Brookfields Mall.'
    );
  });

  test('never throws when the database call fails', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));

    await expect(notifyUnvisitedAssignments({ employeeId: 1 })).resolves.toBeUndefined();
  });
});
