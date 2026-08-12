jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));
jest.mock('../../src/services/googleRoutesService', () => ({ computeRoute: jest.fn() }));
const request = require('supertest');
const pool = require('../../src/db/pool');
const { computeRoute } = require('../../src/services/googleRoutesService');
const { makeApp } = require('../helpers/testApp');

const navigationRouter = require('../../src/routes/navigation.routes');

const REP = { id: 1, role: 'rep', username: 'arun' };
const OTHER_REP = { id: 2, role: 'rep', username: 'divya' };
const MANAGER = { id: 99, role: 'manager', username: 'priya' };

describe('POST /api/x/compute', () => {
  afterEach(() => jest.clearAllMocks());

  test('400 when dealer_id is missing', async () => {
    const app = makeApp(navigationRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/compute').send({ origin_lat: 1, origin_lng: 2 });
    expect(res.status).toBe(400);
  });

  test('404 when the dealer does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(navigationRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/compute').send({ dealer_id: 5, origin_lat: 1, origin_lng: 2 });
    expect(res.status).toBe(404);
  });

  test('422 when the dealer has no coordinates', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 5, name: 'Dealer A', latitude: null, longitude: null }] });
    const app = makeApp(navigationRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/compute').send({ dealer_id: 5, origin_lat: 1, origin_lng: 2 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('dealer_missing_coordinates');
  });

  test('502 when the Routes API call fails', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 5, name: 'Dealer A', latitude: 13, longitude: 77 }] });
    computeRoute.mockRejectedValueOnce(new Error('upstream failed'));
    const app = makeApp(navigationRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/compute').send({ dealer_id: 5, origin_lat: 1, origin_lng: 2 });
    expect(res.status).toBe(502);
  });

  test('201 creates a navigation record and marks the assignment navigating', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 5, name: 'Dealer A', latitude: 13, longitude: 77 }] }) // dealer lookup
      .mockResolvedValueOnce({ rows: [{ id: 20 }] }) // assignment ownership check
      .mockResolvedValueOnce({ rows: [{ id: 100, status: 'navigating', distance_meters: 500 }] }) // insert navigation
      .mockResolvedValueOnce({ rows: [] }); // update assignment status
    computeRoute.mockResolvedValueOnce({
      distanceMeters: 500, durationSeconds: 60, durationInTrafficSeconds: 70, staticDurationSeconds: 55, encodedPolyline: 'xyz',
    });

    const app = makeApp(navigationRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/compute').send({ dealer_id: 5, assignment_id: 20, origin_lat: 1, origin_lng: 2 });

    expect(res.status).toBe(201);
    expect(res.body.navigation.id).toBe(100);
    expect(pool.query.mock.calls[3][0]).toMatch(/UPDATE dealer_assignments/);
  });
});

describe('PATCH /api/x/:id/status', () => {
  afterEach(() => jest.clearAllMocks());

  test('400 when status is invalid', async () => {
    const app = makeApp(navigationRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).patch('/api/x/100/status').send({ status: 'flying' });
    expect(res.status).toBe(400);
  });

  test('404 when the navigation does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(navigationRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).patch('/api/x/100/status').send({ status: 'arrived' });
    expect(res.status).toBe(404);
  });

  test("403 when a rep updates another rep's navigation", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 100, employee_id: OTHER_REP.id, assignment_id: null }] });
    const app = makeApp(navigationRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).patch('/api/x/100/status').send({ status: 'arrived' });
    expect(res.status).toBe(403);
  });

  test('200 updates status and mirrors onto the linked assignment', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 100, employee_id: REP.id, assignment_id: 20 }] })
      .mockResolvedValueOnce({ rows: [{ id: 100, status: 'completed', ended_at: '2026-08-10T10:00:00Z' }] })
      .mockResolvedValueOnce({ rows: [] });

    const app = makeApp(navigationRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).patch('/api/x/100/status').send({ status: 'completed' });

    expect(res.status).toBe(200);
    expect(res.body.navigation.status).toBe('completed');
    expect(pool.query.mock.calls[2][0]).toMatch(/UPDATE dealer_assignments/);
  });

  test('does not mirror a cancelled navigation onto the assignment', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 100, employee_id: REP.id, assignment_id: 20 }] })
      .mockResolvedValueOnce({ rows: [{ id: 100, status: 'cancelled', ended_at: '2026-08-10T10:00:00Z' }] });

    const app = makeApp(navigationRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).patch('/api/x/100/status').send({ status: 'cancelled' });

    expect(res.status).toBe(200);
    expect(pool.query).toHaveBeenCalledTimes(2); // no third call updating dealer_assignments
  });

  test('a late "arrived" from an abandoned navigation attempt cannot regress an already-completed assignment', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 101, employee_id: REP.id, assignment_id: 21 }] })
      .mockResolvedValueOnce({ rows: [{ id: 101, status: 'arrived', ended_at: null }] })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE dealer_assignments — WHERE clause excludes the row (rank guard), 0 rows affected

    const app = makeApp(navigationRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).patch('/api/x/101/status').send({ status: 'arrived' });

    expect(res.status).toBe(200);
    expect(pool.query).toHaveBeenCalledTimes(3);
    const assignmentUpdateSql = pool.query.mock.calls[2][0];
    expect(assignmentUpdateSql).toContain('CASE status');
    expect(assignmentUpdateSql).toContain('CASE $1');
  });

  test('a late "arrived" from an abandoned navigation attempt cannot resurrect a cancelled assignment', async () => {
    // 'cancelled' and 'pending' share rank 0 in the CASE expression — the
    // explicit `status != 'cancelled'` guard is what actually stops this,
    // not the rank comparison alone.
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 102, employee_id: REP.id, assignment_id: 22 }] })
      .mockResolvedValueOnce({ rows: [{ id: 102, status: 'arrived', ended_at: null }] })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE dealer_assignments — status != 'cancelled' excludes the row, 0 rows affected

    const app = makeApp(navigationRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).patch('/api/x/102/status').send({ status: 'arrived' });

    expect(res.status).toBe(200);
    expect(pool.query.mock.calls[2][0]).toContain("status != 'cancelled'");
  });
});

describe('GET /api/x/history', () => {
  afterEach(() => jest.clearAllMocks());

  test('403 when a rep requests history', async () => {
    const app = makeApp(navigationRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).get('/api/x/history');
    expect(res.status).toBe(403);
  });

  test('200 returns paginated history', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ total: 45 }] })
      .mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });

    const app = makeApp(navigationRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/history').query({ page: 2, limit: 20 });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(45);
    expect(res.body.page).toBe(2);
    expect(res.body.pageCount).toBe(3);
    expect(res.body.navigations).toHaveLength(2);
  });
});

describe('GET /api/x/summary/today', () => {
  afterEach(() => jest.clearAllMocks());

  test("200 returns the caller's Daily Travel Summary", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ total_assigned: 4, visited: 2, pending: 2 }] })
      .mockResolvedValueOnce({ rows: [{
        distance_travelled_m: 3000, remaining_distance_m: 5000,
        driving_time_completed_s: 600, estimated_remaining_time_s: 900,
      }] });

    const app = makeApp(navigationRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).get('/api/x/summary/today');

    expect(res.status).toBe(200);
    expect(res.body.total_assigned_dealers).toBe(4);
    expect(res.body.visited_dealers).toBe(2);
    expect(res.body.pending_dealers).toBe(2);
    expect(res.body.total_planned_distance_m).toBe(8000);
    expect(res.body.distance_travelled_m).toBe(3000);
  });
});
