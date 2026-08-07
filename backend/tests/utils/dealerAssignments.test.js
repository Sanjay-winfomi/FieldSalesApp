jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));
const pool = require('../../src/db/pool');
const { markAssignmentVisited } = require('../../src/utils/dealerAssignments');

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
