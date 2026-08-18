jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));
const request = require('supertest');
const pool = require('../../src/db/pool');
const { makeApp } = require('../helpers/testApp');

const notificationsRouter = require('../../src/routes/notifications.routes');
const MANAGER = { id: 99, role: 'manager', username: 'priya' };

describe('GET /api/x', () => {
  afterEach(() => jest.resetAllMocks());

  test('200 lists notifications newest first', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, type: 'day_auto_cutoff' }] });
    const app = makeApp(notificationsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x');
    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(1);
  });
});

describe('GET /api/x/unread-count', () => {
  afterEach(() => jest.resetAllMocks());

  test('200 returns the unread count', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ count: 3 }] });
    const app = makeApp(notificationsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/unread-count');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
  });
});

describe('POST /api/x/read-all', () => {
  afterEach(() => jest.resetAllMocks());

  test('marks everything read EXCEPT notification types that require explicit review', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(notificationsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).post('/api/x/read-all');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // day_auto_cutoff/visit_auto_cutoff must be excluded — opening the page
    // must not silently mark a missed-logout event read before a manager
    // has actually clicked "Reviewed".
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('type != ALL');
    expect(params[0]).toEqual(expect.arrayContaining(['day_auto_cutoff', 'visit_auto_cutoff']));
  });
});

describe('PATCH /api/x/:id/read', () => {
  afterEach(() => jest.resetAllMocks());

  test('400 on an invalid id', async () => {
    const app = makeApp(notificationsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).patch('/api/x/not-a-number/read');
    expect(res.status).toBe(400);
  });

  test('404 when the notification does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(notificationsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).patch('/api/x/20/read');
    expect(res.status).toBe(404);
  });

  test('200 marks a single notification (e.g. an auto-cutoff) as reviewed', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 20, read_at: '2026-08-18T01:00:00Z' }] });
    const app = makeApp(notificationsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).patch('/api/x/20/read');
    expect(res.status).toBe(200);
    expect(res.body.notification.read_at).toBeTruthy();
  });
});
