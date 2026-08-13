jest.mock('../../src/db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));
const request = require('supertest');
const pool = require('../../src/db/pool');
const { makeApp } = require('../helpers/testApp');

// PUT /api/x/ runs inside a transaction via pool.connect(), not pool.query()
// directly — this stub client's own `query` mock is what the route's
// BEGIN/advisory-lock/DELETE/INSERT/COMMIT calls hit.
function mockClient() {
  return { query: jest.fn(), release: jest.fn() };
}

const assignmentsRouter = require('../../src/routes/assignments.routes');

const REP = { id: 1, role: 'rep', username: 'arun' };
const MANAGER = { id: 99, role: 'manager', username: 'priya' };

describe('GET /api/x/', () => {
  afterEach(() => jest.clearAllMocks());

  test('403 when a rep tries to list assignments', async () => {
    const app = makeApp(assignmentsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).get('/api/x/').query({ employee_id: 5 });
    expect(res.status).toBe(403);
  });

  test('400 when employee_id is missing', async () => {
    const app = makeApp(assignmentsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/');
    expect(res.status).toBe(400);
  });

  test("200 lists a rep's assignments ordered by sequence", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, sequence_order: 1, dealer_name: 'Dealer A' }] });
    const app = makeApp(assignmentsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/').query({ employee_id: REP.id });
    expect(res.status).toBe(200);
    expect(res.body.assignments).toHaveLength(1);
  });
});

describe('PUT /api/x/', () => {
  afterEach(() => jest.clearAllMocks());

  test('403 when a rep tries to save an assignment', async () => {
    const app = makeApp(assignmentsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).put('/api/x/').send({ employee_id: REP.id, assignment_date: '2026-08-10', dealer_ids: [1] });
    expect(res.status).toBe(403);
  });

  test('400 when dealer_ids is not an array', async () => {
    const app = makeApp(assignmentsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).put('/api/x/').send({ employee_id: REP.id, assignment_date: '2026-08-10', dealer_ids: 'nope' });
    expect(res.status).toBe(400);
  });

  test('404 when the representative does not exist', async () => {
    const client = mockClient();
    client.query.mockResolvedValueOnce({ rows: [] }); // employee lookup
    pool.connect.mockResolvedValueOnce(client);
    const app = makeApp(assignmentsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).put('/api/x/').send({ employee_id: REP.id, assignment_date: '2026-08-10', dealer_ids: [1] });
    expect(res.status).toBe(404);
    expect(client.release).toHaveBeenCalled();
  });

  test('404 when one of the dealers does not exist', async () => {
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({ rows: [{ id: REP.id }] }) // employee exists
      .mockResolvedValueOnce({ rows: [{ id: 1 }] }); // only 1 of 2 dealers found
    pool.connect.mockResolvedValueOnce(client);
    const app = makeApp(assignmentsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).put('/api/x/').send({ employee_id: REP.id, assignment_date: '2026-08-10', dealer_ids: [1, 2] });
    expect(res.status).toBe(404);
    expect(client.release).toHaveBeenCalled();
  });

  test('200 saves the ordered list — sequence order matches array order', async () => {
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({ rows: [{ id: REP.id }] }) // employee exists
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] }) // dealers exist
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [] }) // delete stale
      .mockResolvedValueOnce({ rows: [] }) // upsert dealer 1
      .mockResolvedValueOnce({ rows: [] }) // upsert dealer 2
      .mockResolvedValueOnce({ rows: [{ id: 10, dealer_id: 1, sequence_order: 1 }, { id: 11, dealer_id: 2, sequence_order: 2 }] }) // final select
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    pool.connect.mockResolvedValueOnce(client);

    const app = makeApp(assignmentsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).put('/api/x/').send({ employee_id: REP.id, assignment_date: '2026-08-10', dealer_ids: [1, 2] });

    expect(res.status).toBe(200);
    expect(res.body.assignments).toHaveLength(2);
    // Upsert calls (index 5 and 6) carry sequence_order 1 and 2 respectively.
    expect(client.query.mock.calls[5][1]).toEqual([REP.id, 1, '2026-08-10', 1, MANAGER.id]);
    expect(client.query.mock.calls[6][1]).toEqual([REP.id, 2, '2026-08-10', 2, MANAGER.id]);
    expect(client.query.mock.calls[8][0]).toBe('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  test('200 clears the whole day when dealer_ids is empty, without inserting anything', async () => {
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({ rows: [{ id: REP.id }] }) // employee exists
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // advisory lock
      .mockResolvedValueOnce({ rows: [] }) // delete everything for that day
      .mockResolvedValueOnce({ rows: [] }) // final select — nothing left
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    pool.connect.mockResolvedValueOnce(client);

    const app = makeApp(assignmentsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).put('/api/x/').send({ employee_id: REP.id, assignment_date: '2026-08-10', dealer_ids: [] });

    expect(res.status).toBe(200);
    expect(res.body.assignments).toEqual([]);
    // No dealer-existence check and no upsert calls when the list is empty —
    // just the employee check, BEGIN, the advisory lock, the clearing
    // DELETE, the final re-select, and COMMIT.
    expect(client.query).toHaveBeenCalledTimes(6);
    expect(client.query.mock.calls[3][0]).toMatch(/DELETE FROM dealer_assignments/);
    expect(client.query.mock.calls[3][1]).toEqual([REP.id, '2026-08-10', []]);
  });
});

describe('DELETE /api/x/:id', () => {
  afterEach(() => jest.clearAllMocks());

  test('403 when a rep tries to delete an assignment', async () => {
    const app = makeApp(assignmentsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).delete('/api/x/5');
    expect(res.status).toBe(403);
  });

  test('404 when the assignment does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(assignmentsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).delete('/api/x/5');
    expect(res.status).toBe(404);
  });

  test('200 deletes the assignment', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 5 }] })
      .mockResolvedValueOnce({ rows: [] });
    const app = makeApp(assignmentsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).delete('/api/x/5');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('GET /api/x/today', () => {
  afterEach(() => jest.clearAllMocks());

  test("200 returns the caller's own assigned dealers (rep access, no manager role required)", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, sequence_order: 1, dealer_name: 'Dealer A', navigation_status: null }],
    });
    const app = makeApp(assignmentsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).get('/api/x/today');
    expect(res.status).toBe(200);
    expect(res.body.assignments).toHaveLength(1);
    expect(pool.query.mock.calls[0][1]).toEqual([REP.id]);
  });
});
