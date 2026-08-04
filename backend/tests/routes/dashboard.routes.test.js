jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));
const request = require('supertest');
const pool = require('../../src/db/pool');
const { makeApp } = require('../helpers/testApp');

const dashboardRouter = require('../../src/routes/dashboard.routes');
const MANAGER = { id: 2, role: 'manager', username: 'priya' };

describe('GET /api/x/today', () => {
  afterEach(() => jest.clearAllMocks());

  test('maps a not-logged-in rep correctly', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ employee_id: 1, name: 'Arun', region: 'South', attendance_id: null, visits_count: '0' }],
    });
    const app = makeApp(dashboardRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/today');
    expect(res.status).toBe(200);
    expect(res.body.reps[0].status).toBe('not_logged_in');
  });

  test('maps a logged-in-at-dealer rep correctly', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        employee_id: 1, name: 'Arun', region: 'South', attendance_id: 5,
        login_time: '2026-07-27T05:00:00Z', logout_time: null,
        dealer_name: 'Dealer A', visit_login: '2026-07-27T06:00:00Z', visit_logout: null,
        visits_count: '1',
      }],
    });
    const app = makeApp(dashboardRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/today');
    expect(res.body.reps[0].status).toBe('logged_in');
    expect(res.body.reps[0].last_activity).toBe('At Dealer A');
  });
});

describe('GET /api/x/rep/:id/today', () => {
  afterEach(() => jest.clearAllMocks());

  test('400 on an invalid rep id', async () => {
    const app = makeApp(dashboardRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/rep/abc/today');
    expect(res.status).toBe(400);
  });

  test('404 when the rep does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(dashboardRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/rep/999/today');
    expect(res.status).toBe(404);
  });

  test('returns null attendance when the rep has no record today', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Arun' }] })
      .mockResolvedValueOnce({ rows: [] });
    const app = makeApp(dashboardRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/rep/1/today');
    expect(res.status).toBe(200);
    expect(res.body.attendance).toBeNull();
  });
});

