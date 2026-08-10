jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));
jest.mock('../../src/utils/managerNotifications', () => ({ createManagerNotification: jest.fn() }));
const request = require('supertest');
const pool = require('../../src/db/pool');
const { createManagerNotification } = require('../../src/utils/managerNotifications');
const { makeApp } = require('../helpers/testApp');

const followupRequestsRouter = require('../../src/routes/followupRequests.routes');

const REP = { id: 1, role: 'rep', username: 'arun' };
const MANAGER = { id: 99, role: 'manager', username: 'priya' };

const FUTURE_DATE = '2099-01-01';
const LONG_REASON = 'Dealer asked to come back tomorrow instead';

describe('POST /api/x/', () => {
  afterEach(() => jest.clearAllMocks());

  test('400 when dealer_id is missing', async () => {
    const app = makeApp(followupRequestsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/').send({ requested_date: FUTURE_DATE, reason: LONG_REASON });
    expect(res.status).toBe(400);
  });

  test('422 when requested_date is in the past', async () => {
    const app = makeApp(followupRequestsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/').send({ dealer_id: 5, requested_date: '2020-01-01', reason: LONG_REASON });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('requested_date_in_past');
  });

  test('422 when reason is too short', async () => {
    const app = makeApp(followupRequestsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/').send({ dealer_id: 5, requested_date: FUTURE_DATE, reason: 'short' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('reason_too_short');
  });

  test('404 when the dealer does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(followupRequestsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/').send({ dealer_id: 5, requested_date: FUTURE_DATE, reason: LONG_REASON });
    expect(res.status).toBe(404);
  });

  test('201 creates the request and notifies managers', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 5, name: 'Dealer A' }] }) // dealer lookup
      .mockResolvedValueOnce({ rows: [{ id: 20, employee_id: REP.id, dealer_id: 5, requested_date: FUTURE_DATE, reason: LONG_REASON, status: 'pending' }] }); // insert

    const app = makeApp(followupRequestsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/').send({ dealer_id: 5, requested_date: FUTURE_DATE, reason: LONG_REASON });

    expect(res.status).toBe(201);
    expect(res.body.request.id).toBe(20);
    expect(createManagerNotification).toHaveBeenCalledWith(expect.objectContaining({
      type: 'followup_request',
      employeeId: REP.id,
      dealerId: 5,
      followupRequestId: 20,
    }));
  });

  test('404 when assignment_id does not belong to the requesting rep', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 5, name: 'Dealer A' }] }) // dealer lookup
      .mockResolvedValueOnce({ rows: [] }); // assignment lookup finds nothing for this employee

    const app = makeApp(followupRequestsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/').send({ dealer_id: 5, assignment_id: 999, requested_date: FUTURE_DATE, reason: LONG_REASON });

    expect(res.status).toBe(404);
  });
});

describe('GET /api/x/', () => {
  afterEach(() => jest.clearAllMocks());

  test('403 when a rep tries to list requests', async () => {
    const app = makeApp(followupRequestsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).get('/api/x/');
    expect(res.status).toBe(403);
  });

  test('400 on an invalid status filter', async () => {
    const app = makeApp(followupRequestsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/').query({ status: 'bogus' });
    expect(res.status).toBe(400);
  });

  test('200 lists requests, filtered by status when given', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 20, status: 'pending' }] });
    const app = makeApp(followupRequestsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/').query({ status: 'pending' });
    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
    expect(pool.query.mock.calls[0][1]).toEqual(['pending']);
  });
});

describe('PATCH /api/x/:id/approve', () => {
  afterEach(() => jest.clearAllMocks());

  test('403 when a rep tries to approve', async () => {
    const app = makeApp(followupRequestsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).patch('/api/x/20/approve');
    expect(res.status).toBe(403);
  });

  test('404 when the request does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(followupRequestsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).patch('/api/x/20/approve');
    expect(res.status).toBe(404);
  });

  test('409 when the request was already resolved', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 20, status: 'approved' }] });
    const app = makeApp(followupRequestsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).patch('/api/x/20/approve');
    expect(res.status).toBe(409);
  });

  test('200 creates the assignment at the next sequence position and marks the request approved', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 20, employee_id: REP.id, dealer_id: 5, requested_date: FUTURE_DATE, status: 'pending' }] }) // existing
      .mockResolvedValueOnce({ rows: [{ next_seq: 3 }] }) // next sequence
      .mockResolvedValueOnce({ rows: [{ id: 555 }] }) // insert assignment
      .mockResolvedValueOnce({ rows: [{ id: 20, status: 'approved' }] }); // update request

    const app = makeApp(followupRequestsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).patch('/api/x/20/approve');

    expect(res.status).toBe(200);
    expect(res.body.assignment_id).toBe(555);
    expect(res.body.request.status).toBe('approved');
    expect(pool.query.mock.calls[2][1]).toEqual([REP.id, 5, FUTURE_DATE, 3, MANAGER.id]);
  });
});

describe('PATCH /api/x/:id/reject', () => {
  afterEach(() => jest.clearAllMocks());

  test('403 when a rep tries to reject', async () => {
    const app = makeApp(followupRequestsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).patch('/api/x/20/reject');
    expect(res.status).toBe(403);
  });

  test('409 when the request was already resolved', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ status: 'rejected' }] });
    const app = makeApp(followupRequestsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).patch('/api/x/20/reject');
    expect(res.status).toBe(409);
  });

  test('200 marks the request rejected', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ status: 'pending' }] })
      .mockResolvedValueOnce({ rows: [{ id: 20, status: 'rejected' }] });

    const app = makeApp(followupRequestsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).patch('/api/x/20/reject');

    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('rejected');
  });
});
