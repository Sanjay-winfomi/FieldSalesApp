jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));
const request = require('supertest');
const pool = require('../../src/db/pool');
const { makeApp } = require('../helpers/testApp');

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
    pool.query.mockResolvedValueOnce({ rows: [] }); // employee lookup
    const app = makeApp(assignmentsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).put('/api/x/').send({ employee_id: REP.id, assignment_date: '2026-08-10', dealer_ids: [1] });
    expect(res.status).toBe(404);
  });

  test('404 when one of the dealers does not exist', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: REP.id }] }) // employee exists
      .mockResolvedValueOnce({ rows: [{ id: 1 }] }); // only 1 of 2 dealers found
    const app = makeApp(assignmentsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).put('/api/x/').send({ employee_id: REP.id, assignment_date: '2026-08-10', dealer_ids: [1, 2] });
    expect(res.status).toBe(404);
  });

  test('200 saves the ordered list — sequence order matches array order', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: REP.id }] }) // employee exists
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] }) // dealers exist
      .mockResolvedValueOnce({ rows: [] }) // delete stale
      .mockResolvedValueOnce({ rows: [] }) // upsert dealer 1
      .mockResolvedValueOnce({ rows: [] }) // upsert dealer 2
      .mockResolvedValueOnce({ rows: [{ id: 10, dealer_id: 1, sequence_order: 1 }, { id: 11, dealer_id: 2, sequence_order: 2 }] }); // final select

    const app = makeApp(assignmentsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).put('/api/x/').send({ employee_id: REP.id, assignment_date: '2026-08-10', dealer_ids: [1, 2] });

    expect(res.status).toBe(200);
    expect(res.body.assignments).toHaveLength(2);
    // Upsert calls (index 3 and 4) carry sequence_order 1 and 2 respectively.
    expect(pool.query.mock.calls[3][1]).toEqual([REP.id, 1, '2026-08-10', 1, MANAGER.id]);
    expect(pool.query.mock.calls[4][1]).toEqual([REP.id, 2, '2026-08-10', 2, MANAGER.id]);
  });

  test('200 clears the whole day when dealer_ids is empty, without inserting anything', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: REP.id }] }) // employee exists
      .mockResolvedValueOnce({ rows: [] }) // delete everything for that day
      .mockResolvedValueOnce({ rows: [] }); // final select — nothing left

    const app = makeApp(assignmentsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).put('/api/x/').send({ employee_id: REP.id, assignment_date: '2026-08-10', dealer_ids: [] });

    expect(res.status).toBe(200);
    expect(res.body.assignments).toEqual([]);
    // No dealer-existence check and no upsert calls when the list is empty —
    // just the employee check, the clearing DELETE, and the final re-select.
    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(pool.query.mock.calls[1][0]).toMatch(/DELETE FROM dealer_assignments/);
    expect(pool.query.mock.calls[1][1]).toEqual([REP.id, '2026-08-10', []]);
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
