jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));
const request = require('supertest');
const pool = require('../../src/db/pool');
const { makeApp } = require('../helpers/testApp');

const attendanceRouter = require('../../src/routes/attendance.routes');

describe('POST /api/x/login', () => {
  afterEach(() => jest.resetAllMocks());

  test('400 when lat/lng missing', async () => {
    const app = makeApp(attendanceRouter, { basePath: '/api/x' });
    const res = await request(app).post('/api/x/login').send({});
    expect(res.status).toBe(400);
  });

  test('400 when lat/lng out of range', async () => {
    const app = makeApp(attendanceRouter, { basePath: '/api/x' });
    const res = await request(app).post('/api/x/login').send({ lat: 200, lng: 10 });
    expect(res.status).toBe(400);
  });

  test('201 creates a new attendance record', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 5, login_time: '2026-07-27T05:00:00Z', login_lat: 11, login_lng: 77 }] });
    const app = makeApp(attendanceRouter, { basePath: '/api/x' });
    const res = await request(app).post('/api/x/login').send({ lat: 11, lng: 77 });
    expect(res.status).toBe(201);
    expect(res.body.attendance.id).toBe(5);
  });

  test('409 with the existing attendance_id when already logged in today', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // INSERT ... ON CONFLICT DO NOTHING -> no rows
      .mockResolvedValueOnce({ rows: [{ id: 9 }] }); // SELECT existing
    const app = makeApp(attendanceRouter, { basePath: '/api/x' });
    const res = await request(app).post('/api/x/login').send({ lat: 11, lng: 77 });
    expect(res.status).toBe(409);
    expect(res.body.attendance_id).toBe(9);
  });
});

describe('POST /api/x/logout', () => {
  afterEach(() => jest.resetAllMocks());

  test('400 when attendance_id or coords missing', async () => {
    const app = makeApp(attendanceRouter, { basePath: '/api/x' });
    const res = await request(app).post('/api/x/logout').send({ lat: 11, lng: 77 });
    expect(res.status).toBe(400);
  });

  test('404 when the attendance record does not belong to this employee', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(attendanceRouter, { basePath: '/api/x' });
    const res = await request(app).post('/api/x/logout').send({ attendance_id: 5, lat: 11, lng: 77 });
    expect(res.status).toBe(404);
  });

  test('409 with the authoritative record when already logged out', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 5, login_time: '2026-07-27T05:00:00Z', logout_time: '2026-07-27T13:00:00Z', total_distance_km: 3 }],
    });
    const app = makeApp(attendanceRouter, { basePath: '/api/x' });
    const res = await request(app).post('/api/x/logout').send({ attendance_id: 5, lat: 11, lng: 77 });
    expect(res.status).toBe(409);
    expect(res.body.attendance).toEqual({ id: 5, logout_time: '2026-07-27T13:00:00Z' });
  });

  test('200 logs out successfully with a visit summary', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 5, login_time: '2026-07-27T05:00:00Z', logout_time: null, total_distance_km: 3 }] })
      .mockResolvedValueOnce({ rows: [] }) // no open dealer visit
      .mockResolvedValueOnce({ rows: [{ id: 5, login_time: '2026-07-27T05:00:00Z', logout_time: '2026-07-27T13:00:00Z', total_distance_km: 3, total_duration_minutes: 480 }] })
      .mockResolvedValueOnce({ rows: [{ visits_count: '4' }] });
    const app = makeApp(attendanceRouter, { basePath: '/api/x' });
    const res = await request(app).post('/api/x/logout').send({ attendance_id: 5, lat: 11, lng: 77 });
    expect(res.status).toBe(200);
    expect(res.body.summary.visits_count).toBe(4);
  });

  test('auto-closes a still-open dealer visit when the day ends', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 5, login_time: '2026-07-27T05:00:00Z', logout_time: null, total_distance_km: 3 }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 90, dealer_id: 7, login_time: '2026-07-27T10:00:00Z', dealer_name: 'Dealer Z',
          dealer_lat: 11, dealer_lng: 77, dealer_radius_meters: 200,
        }],
      }) // open dealer visit found
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE client_visits (auto-close) — this request won the race
      .mockResolvedValueOnce({ rows: [] }) // createManagerNotification insert
      .mockResolvedValueOnce({ rows: [{ id: 5, login_time: '2026-07-27T05:00:00Z', logout_time: '2026-07-27T13:00:00Z', total_distance_km: 3, total_duration_minutes: 480 }] })
      .mockResolvedValueOnce({ rows: [{ visits_count: '1' }] });
    const app = makeApp(attendanceRouter, { basePath: '/api/x' });
    const res = await request(app).post('/api/x/logout').send({ attendance_id: 5, lat: 11, lng: 77 });
    expect(res.status).toBe(200);
    // The UPDATE ...client_visits call is the 3rd pool.query call.
    expect(pool.query.mock.calls[2][0]).toContain('UPDATE client_visits');
    expect(pool.query.mock.calls[2][0]).toContain('AND logout_time IS NULL');
    expect(pool.query.mock.calls[2][1]).toEqual([11, 77, expect.any(Number), false, expect.any(String), 90]);
  });

  test('does not overwrite or notify when a manual dealer logout wins the race to close the visit first', async () => {
    pool.query.mockImplementation((sql) => {
      if (/SELECT id, login_time, logout_time, total_distance_km/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 5, login_time: '2026-07-27T05:00:00Z', logout_time: null, total_distance_km: 3 }] });
      }
      if (/FROM client_visits cv\s+JOIN dealers d/.test(sql)) {
        // Stale read — a concurrent manual logout closes the visit before the UPDATE below runs.
        return Promise.resolve({
          rows: [{
            id: 90, dealer_id: 7, login_time: '2026-07-27T10:00:00Z', dealer_name: 'Dealer Z',
            dealer_lat: 11, dealer_lng: 77, dealer_radius_meters: 200,
          }],
        });
      }
      if (/UPDATE client_visits/.test(sql)) {
        return Promise.resolve({ rows: [], rowCount: 0 }); // lost the race — logout_time was no longer NULL
      }
      if (/UPDATE attendance/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 5, login_time: '2026-07-27T05:00:00Z', logout_time: '2026-07-27T13:00:00Z', total_distance_km: 3, total_duration_minutes: 480 }] });
      }
      if (/COUNT\(\*\) AS visits_count/.test(sql)) {
        return Promise.resolve({ rows: [{ visits_count: '1' }] });
      }
      // notifyUnvisitedAssignments's own queries, and anything else — an
      // empty result is fine for this test's purposes.
      return Promise.resolve({ rows: [] });
    });

    const app = makeApp(attendanceRouter, { basePath: '/api/x' });
    const res = await request(app).post('/api/x/logout').send({ attendance_id: 5, lat: 11, lng: 77 });
    expect(res.status).toBe(200);

    const notificationInsertCalls = pool.query.mock.calls.filter(([sql]) => /INSERT INTO manager_notifications/.test(sql));
    expect(notificationInsertCalls.every(([, params]) => params[0] !== 'visit_auto_closed_on_day_logout')).toBe(true);
  });
});

describe('GET /api/x/today', () => {
  afterEach(() => jest.resetAllMocks());

  test('returns null attendance when no record exists for today', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(attendanceRouter, { basePath: '/api/x' });
    const res = await request(app).get('/api/x/today');
    expect(res.status).toBe(200);
    expect(res.body.attendance).toBeNull();
    expect(res.body.visits).toEqual([]);
  });
});

describe('GET /api/x/:id — authorization', () => {
  afterEach(() => jest.resetAllMocks());

  test("403 when a rep requests another employee's attendance record", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 5, employee_id: 999 }] });
    const app = makeApp(attendanceRouter, { basePath: '/api/x', employee: { id: 1, role: 'rep', username: 'arun' } });
    const res = await request(app).get('/api/x/5');
    expect(res.status).toBe(403);
  });

  test('a manager can view any attendance record', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 5, employee_id: 999 }] });
    const app = makeApp(attendanceRouter, { basePath: '/api/x', employee: { id: 1, role: 'manager', username: 'priya' } });
    const res = await request(app).get('/api/x/5');
    expect(res.status).toBe(200);
  });
});
