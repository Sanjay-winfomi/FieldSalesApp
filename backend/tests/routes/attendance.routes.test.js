jest.mock('../../src/db/pool', () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock('../../src/services/googleRoutesService', () => ({ computeRoute: jest.fn() }));
jest.mock('../../src/utils/managerNotifications', () => ({ createManagerNotification: jest.fn() }));
const request = require('supertest');
const pool = require('../../src/db/pool');
const { computeRoute } = require('../../src/services/googleRoutesService');
const { createManagerNotification } = require('../../src/utils/managerNotifications');
const { makeApp } = require('../helpers/testApp');

const attendanceRouter = require('../../src/routes/attendance.routes');

beforeEach(() => {
  // Default: every /logout test that reaches the final-leg computation gets
  // a successful Google Routes API response, since haversine no longer
  // backs it up on failure. Individual tests override this to exercise the
  // failure path.
  computeRoute.mockResolvedValue({ distanceMeters: 1000 });
  createManagerNotification.mockResolvedValue();
});

// POST /api/x/logout runs inside a transaction via pool.connect(), not
// pool.query() directly — this stub client's own `query` mock is what the
// route's BEGIN/SELECT.../UPDATE/COMMIT/ROLLBACK calls hit.
function mockClient() {
  return { query: jest.fn(), release: jest.fn() };
}

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

  test('400 when accuracy_meters is present but invalid', async () => {
    const app = makeApp(attendanceRouter, { basePath: '/api/x' });
    const res = await request(app).post('/api/x/login').send({ lat: 11, lng: 77, accuracy_meters: -5 });
    expect(res.status).toBe(400);
  });

  test('422 when accuracy_meters exceeds the threshold', async () => {
    const app = makeApp(attendanceRouter, { basePath: '/api/x' });
    const res = await request(app).post('/api/x/login').send({ lat: 11, lng: 77, accuracy_meters: 500 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('gps_accuracy_exceeded');
  });

  test('201 when accuracy_meters is omitted (optional, for backward-compat with older queued actions)', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 5, login_time: '2026-07-27T05:00:00Z', login_lat: 11, login_lng: 77 }] });
    const app = makeApp(attendanceRouter, { basePath: '/api/x' });
    const res = await request(app).post('/api/x/login').send({ lat: 11, lng: 77 });
    expect(res.status).toBe(201);
  });

  test('201 when accuracy_meters is present and within the threshold', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 5, login_time: '2026-07-27T05:00:00Z', login_lat: 11, login_lng: 77 }] });
    const app = makeApp(attendanceRouter, { basePath: '/api/x' });
    const res = await request(app).post('/api/x/login').send({ lat: 11, lng: 77, accuracy_meters: 12 });
    expect(res.status).toBe(201);
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

  test('422 when accuracy_meters exceeds the threshold', async () => {
    const app = makeApp(attendanceRouter, { basePath: '/api/x' });
    const res = await request(app).post('/api/x/logout').send({ attendance_id: 5, lat: 11, lng: 77, accuracy_meters: 500 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('gps_accuracy_exceeded');
  });

  test('404 when the attendance record does not belong to this employee', async () => {
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // attendance (FOR UPDATE) — not found
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK
    pool.connect.mockResolvedValueOnce(client);
    const app = makeApp(attendanceRouter, { basePath: '/api/x' });
    const res = await request(app).post('/api/x/logout').send({ attendance_id: 5, lat: 11, lng: 77 });
    expect(res.status).toBe(404);
    expect(client.release).toHaveBeenCalled();
  });

  test('409 with the authoritative record when already logged out', async () => {
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{ id: 5, login_time: '2026-07-27T05:00:00Z', logout_time: '2026-07-27T13:00:00Z', total_distance_km: 3 }],
      }) // attendance (FOR UPDATE) — already logged out
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK
    pool.connect.mockResolvedValueOnce(client);
    const app = makeApp(attendanceRouter, { basePath: '/api/x' });
    const res = await request(app).post('/api/x/logout').send({ attendance_id: 5, lat: 11, lng: 77 });
    expect(res.status).toBe(409);
    expect(res.body.attendance).toEqual({ id: 5, logout_time: '2026-07-27T13:00:00Z' });
  });

  test('200 logs out successfully with a visit summary', async () => {
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 5, login_time: '2026-07-27T05:00:00Z', login_lat: 11, login_lng: 77, logout_time: null, total_distance_km: 3 }] }) // attendance (FOR UPDATE)
      .mockResolvedValueOnce({ rows: [] }) // no open dealer visit
      .mockResolvedValueOnce({ rows: [] }) // no closed dealer visits either — final leg falls back to login point
      .mockResolvedValueOnce({ rows: [{ id: 5, login_time: '2026-07-27T05:00:00Z', logout_time: '2026-07-27T13:00:00Z', total_distance_km: 3, total_duration_minutes: 480 }] }) // UPDATE attendance
      .mockResolvedValueOnce({ rows: [{ visits_count: '4' }] }) // visits count
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    pool.connect.mockResolvedValueOnce(client);
    const app = makeApp(attendanceRouter, { basePath: '/api/x' });
    const res = await request(app).post('/api/x/logout').send({ attendance_id: 5, lat: 11, lng: 77 });
    expect(res.status).toBe(200);
    expect(res.body.summary.visits_count).toBe(4);
    expect(client.release).toHaveBeenCalled();
  });

  test('502 with a retry message when the Routes API fails for the final leg, instead of falling back to haversine', async () => {
    computeRoute.mockRejectedValueOnce(new Error('upstream failed'));
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 5, login_time: '2026-07-27T05:00:00Z', login_lat: 11, login_lng: 77, logout_time: null, total_distance_km: 3 }] }) // attendance (FOR UPDATE)
      .mockResolvedValueOnce({ rows: [] }) // no open dealer visit
      .mockResolvedValueOnce({ rows: [] }) // no closed dealer visits either
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK
    pool.connect.mockResolvedValueOnce(client);
    const app = makeApp(attendanceRouter, { basePath: '/api/x' });
    const res = await request(app).post('/api/x/logout').send({ attendance_id: 5, lat: 11, lng: 77 });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('route_computation_failed');
    expect(res.body.message).toBe('Request timed out — Retry');
    // The day was never actually logged out — no UPDATE attendance / COMMIT call, and the
    // transaction was rolled back and its client released instead of leaking.
    expect(client.query.mock.calls.some(([sql]) => /UPDATE attendance/.test(sql))).toBe(false);
    expect(client.query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  test('409 when a concurrent logout request wins the race to close the day first', async () => {
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 5, login_time: '2026-07-27T05:00:00Z', login_lat: 11, login_lng: 77, logout_time: null, total_distance_km: 3 }] }) // attendance (FOR UPDATE)
      .mockResolvedValueOnce({ rows: [] }) // no open dealer visit
      .mockResolvedValueOnce({ rows: [] }) // no closed dealer visits either
      // The UPDATE ... WHERE logout_time IS NULL matches zero rows — a
      // concurrent request already completed the logout in between.
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK
    pool.connect.mockResolvedValueOnce(client);
    // The lost-race authoritative re-fetch runs on the plain pool (not the
    // transaction client), since the transaction has already rolled back by then.
    pool.query.mockResolvedValueOnce({ rows: [{ id: 5, logout_time: '2026-07-27T13:00:01Z' }] });
    const app = makeApp(attendanceRouter, { basePath: '/api/x' });
    const res = await request(app).post('/api/x/logout').send({ attendance_id: 5, lat: 11, lng: 77 });
    expect(res.status).toBe(409);
    expect(res.body.attendance).toEqual({ id: 5, logout_time: '2026-07-27T13:00:01Z' });
  });

  test('auto-closes a still-open dealer visit when the day ends', async () => {
    const client = mockClient();
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: 5, login_time: '2026-07-27T05:00:00Z', login_lat: 11, login_lng: 77, logout_time: null, total_distance_km: 3 }] }) // attendance (FOR UPDATE)
      .mockResolvedValueOnce({
        rows: [{
          id: 90, dealer_id: 7, login_time: '2026-07-27T10:00:00Z', dealer_name: 'Dealer Z',
          dealer_lat: 11, dealer_lng: 77, dealer_radius_meters: 200,
        }],
      }) // open dealer visit found
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE client_visits (auto-close) — this request won the race
      .mockResolvedValueOnce({ rows: [{ logout_lat: 11, logout_lng: 77 }] }) // final leg origin = the just-auto-closed visit's logout point
      .mockResolvedValueOnce({ rows: [{ id: 5, login_time: '2026-07-27T05:00:00Z', logout_time: '2026-07-27T13:00:00Z', total_distance_km: 3, total_duration_minutes: 480 }] }) // UPDATE attendance
      .mockResolvedValueOnce({ rows: [{ visits_count: '1' }] }) // visits count
      .mockResolvedValueOnce({ rows: [] }); // COMMIT
    pool.connect.mockResolvedValueOnce(client);
    const app = makeApp(attendanceRouter, { basePath: '/api/x' });
    const res = await request(app).post('/api/x/logout').send({ attendance_id: 5, lat: 11, lng: 77 });
    expect(res.status).toBe(200);
    // The UPDATE ...client_visits call is the 4th client.query call (after BEGIN, attendance SELECT, open-visit SELECT).
    expect(client.query.mock.calls[3][0]).toContain('UPDATE client_visits');
    expect(client.query.mock.calls[3][0]).toContain('AND logout_time IS NULL');
    expect(client.query.mock.calls[3][1]).toEqual([11, 77, expect.any(Number), false, expect.any(String), 90]);
    // The auto-close notification is only sent once the transaction has actually committed.
    expect(createManagerNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'visit_auto_closed_on_day_logout', dealerId: 7, visitId: 90 })
    );
  });

  test('does not overwrite or notify when a manual dealer logout wins the race to close the visit first', async () => {
    const client = mockClient();
    client.query.mockImplementation((sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (/SELECT id, login_time, login_lat, login_lng, logout_time, total_distance_km/.test(sql)) {
        return Promise.resolve({ rows: [{ id: 5, login_time: '2026-07-27T05:00:00Z', login_lat: 11, login_lng: 77, logout_time: null, total_distance_km: 3 }] });
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
      // The final-leg origin lookup and anything else — an empty result is
      // fine for this test's purposes.
      return Promise.resolve({ rows: [] });
    });
    pool.connect.mockResolvedValueOnce(client);
    // notifyUnvisitedAssignments's own queries run against the plain pool,
    // fire-and-forget — an empty result is fine for this test's purposes.
    pool.query.mockResolvedValue({ rows: [] });

    const app = makeApp(attendanceRouter, { basePath: '/api/x' });
    const res = await request(app).post('/api/x/logout').send({ attendance_id: 5, lat: 11, lng: 77 });
    expect(res.status).toBe(200);

    // The UPDATE lost the race (rowCount 0), so autoClosedVisit stays null
    // and the auto-close notification must never fire.
    expect(createManagerNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'visit_auto_closed_on_day_logout' })
    );
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
