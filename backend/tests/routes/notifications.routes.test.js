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
    // A soft-dismissed day_absent row must not resurface in the feed.
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('n.dismissed_at IS NULL');
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
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain('dismissed_at IS NULL');
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
    expect(params[0]).toEqual(expect.arrayContaining(['day_auto_cutoff', 'visit_auto_cutoff', 'day_absent']));
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

describe('DELETE /api/x/:id', () => {
  afterEach(() => jest.resetAllMocks());

  test('400 on an invalid id', async () => {
    const app = makeApp(notificationsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).delete('/api/x/not-a-number');
    expect(res.status).toBe(400);
  });

  test('200 deletes a reviewed auto-cutoff notification', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 20 }] });
    const app = makeApp(notificationsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).delete('/api/x/20');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // The eligibility rule (reviewed, or an approved/rejected follow-up
    // request) is enforced in the query itself, not just client-side.
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('read_at IS NOT NULL');
    expect(sql).toContain("status IN ('approved', 'rejected')");
    expect(params[0]).toBe(20);
    expect(params[1]).toEqual(expect.arrayContaining(['day_auto_cutoff', 'visit_auto_cutoff', 'day_absent']));
  });

  // A day_absent row must be soft-dismissed, not hard-deleted — absenceCheck.js
  // re-flags the same employee+business_date on its next 15-minute sweep as
  // soon as no day_absent row for that pair still exists, so an actual DELETE
  // let a reviewed-and-cleared absence notification silently come back as a
  // brand-new, unreviewed one.
  test('200 soft-dismisses (does not hard-delete) a reviewed day_absent notification', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 21 }] });
    const app = makeApp(notificationsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).delete('/api/x/21');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain("UPDATE manager_notifications SET dismissed_at = NOW()");
    expect(sql).toContain("WHERE id IN (SELECT id FROM target WHERE type = 'day_absent')");
    expect(sql).toContain("DELETE FROM manager_notifications");
    expect(sql).toContain("WHERE id IN (SELECT id FROM target WHERE type <> 'day_absent')");
  });

  test('404 when the notification does not exist, or is not yet reviewed/resolved', async () => {
    // The query's WHERE clause matches zero rows either way — the route
    // can't (and doesn't need to) distinguish "wrong id" from "not eligible
    // yet" from a single DELETE ... RETURNING result.
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(notificationsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).delete('/api/x/20');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/x (bulk clear)', () => {
  afterEach(() => jest.resetAllMocks());

  test('200 deletes every currently-eligible notification and reports the count', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 20 }, { id: 21 }, { id: 22 }] });
    const app = makeApp(notificationsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).delete('/api/x');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.deleted).toBe(3);
    // Same eligibility rule as the single-id route, just with no id filter.
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toContain('n.id = $1');
    expect(sql).toContain('read_at IS NOT NULL');
    expect(sql).toContain("status IN ('approved', 'rejected')");
    expect(params[0]).toEqual(expect.arrayContaining(['day_auto_cutoff', 'visit_auto_cutoff', 'day_absent']));
  });

  test('200 with deleted: 0 when nothing is currently eligible', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(notificationsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).delete('/api/x');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(0);
  });
});
