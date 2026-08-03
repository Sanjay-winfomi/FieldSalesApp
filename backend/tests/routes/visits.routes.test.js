jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));
const request = require('supertest');
const pool = require('../../src/db/pool');
const { makeApp } = require('../helpers/testApp');

const visitsRouter = require('../../src/routes/visits.routes');

const REP = { id: 1, role: 'rep', username: 'arun' };
const MANAGER = { id: 2, role: 'manager', username: 'priya' };

describe('POST /api/x/check-in', () => {
  afterEach(() => jest.clearAllMocks());

  test('400 when required fields are missing', async () => {
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/check-in').send({ dealer_id: 1 });
    expect(res.status).toBe(400);
  });

  test('422 when GPS accuracy exceeds the threshold', async () => {
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app)
      .post('/api/x/check-in')
      .send({ attendance_id: 1, dealer_id: 1, lat: 11, lng: 77, accuracy_meters: 999 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('gps_accuracy_exceeded');
  });

  test('422 with reason_required when outside radius and no reason given', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, check_in_lat: 11, check_in_lng: 77 }] }) // attendance
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Dealer A', latitude: 11, longitude: 77, radius_meters: 100 }] }); // dealer
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app)
      .post('/api/x/check-in')
      .send({ attendance_id: 1, dealer_id: 1, lat: 12, lng: 78, accuracy_meters: 10 }); // ~150km away
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('reason_required');
  });

  test('201 checks in successfully inside the radius', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, check_in_lat: 11, check_in_lng: 77 }] }) // attendance
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Dealer A', latitude: 11, longitude: 77, radius_meters: 200 }] }) // dealer
      .mockResolvedValueOnce({ rows: [] }) // last visit (none)
      .mockResolvedValueOnce({ rows: [{ id: 55, dealer_id: 1, check_in_time: 'now', check_in_lat: 11, check_in_lng: 77 }] }) // insert visit
      .mockResolvedValueOnce({ rows: [] }); // update attendance distance
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app)
      .post('/api/x/check-in')
      .send({ attendance_id: 1, dealer_id: 1, lat: 11, lng: 77, accuracy_meters: 10 });
    expect(res.status).toBe(201);
    expect(res.body.visit.id).toBe(55);
    expect(res.body.visit.dealer_name).toBe('Dealer A');
  });

  test('404 when the dealer does not exist', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, check_in_lat: 11, check_in_lng: 77 }] })
      .mockResolvedValueOnce({ rows: [] });
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app)
      .post('/api/x/check-in')
      .send({ attendance_id: 1, dealer_id: 999, lat: 11, lng: 77, accuracy_meters: 10 });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/x/check-out', () => {
  afterEach(() => jest.clearAllMocks());

  test('409 with the authoritative visit record when already checked out', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 55, attendance_id: 1, dealer_id: 1,
        check_in_time: '2026-07-27T05:00:00Z', check_out_time: '2026-07-27T06:00:00Z',
        check_in_lat: 11, check_in_lng: 77,
        dealer_name: 'Dealer A', dealer_lat: 11, dealer_lng: 77, dealer_radius_meters: 200,
      }],
    });
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/check-out').send({ visit_id: 55, lat: 11, lng: 77, accuracy_meters: 10 });
    expect(res.status).toBe(409);
    expect(res.body.visit).toEqual({ id: 55, check_out_time: '2026-07-27T06:00:00Z' });
  });

  test('200 checks out successfully inside the radius', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 55, attendance_id: 1, dealer_id: 1,
          check_in_time: '2026-07-27T05:00:00Z', check_out_time: null,
          check_in_lat: 11, check_in_lng: 77,
          dealer_name: 'Dealer A', dealer_lat: 11, dealer_lng: 77, dealer_radius_meters: 200,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 55, check_out_time: 'now', visit_duration_minutes: 30, out_of_radius: false, matched_check_in: false }] });
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/check-out').send({ visit_id: 55, lat: 11, lng: 77, accuracy_meters: 10 });
    expect(res.status).toBe(200);
    expect(res.body.visit.out_of_radius).toBe(false);
  });
});

describe('POST /api/x/:id/location-check', () => {
  afterEach(() => jest.clearAllMocks());

  test('400 on invalid lat/lng', async () => {
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/55/location-check').send({ lat: 999, lng: 77 });
    expect(res.status).toBe(400);
  });

  test('404 when the visit does not belong to this employee', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/55/location-check').send({ lat: 11, lng: 77 });
    expect(res.status).toBe(404);
  });

  test('records "inside" without incrementing the breach count', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 55, dealer_id: 1, check_out_time: null, outside_radius_count: 0, log_out_alert_sent: false,
          dealer_name: 'Dealer A', dealer_lat: 11, dealer_lng: 77, radius_meters: 200,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 55, last_location_status: 'inside', outside_radius_count: 0, log_out_alert_sent: false, interrupted: false }] });
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/55/location-check').send({ lat: 11, lng: 77 });
    expect(res.status).toBe(200);
    expect(res.body.visit.last_location_status).toBe('inside');
    expect(pool.query).toHaveBeenCalledTimes(2); // no exception_log insert
  });

  test('one breach: increments count but does not yet trigger the logout alert', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 55, dealer_id: 1, check_out_time: null, outside_radius_count: 0, log_out_alert_sent: false,
          dealer_name: 'Dealer A', dealer_lat: 11, dealer_lng: 77, radius_meters: 100,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 55, last_location_status: 'outside', outside_radius_count: 1, log_out_alert_sent: false, interrupted: false }] });
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/55/location-check').send({ lat: 12, lng: 78 }); // ~150km away
    expect(res.status).toBe(200);
    expect(res.body.visit.outside_radius_count).toBe(1);
    expect(res.body.visit.log_out_alert_sent).toBe(false);
    expect(pool.query).toHaveBeenCalledTimes(2); // still no exception_log insert
  });

  test('second breach (non-consecutive) trips the logout alert and logs an exception', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 55, dealer_id: 1, check_out_time: null, outside_radius_count: 1, log_out_alert_sent: false,
          dealer_name: 'Dealer A', dealer_lat: 11, dealer_lng: 77, radius_meters: 100,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 55, last_location_status: 'outside', outside_radius_count: 2, log_out_alert_sent: true, interrupted: true }] })
      .mockResolvedValueOnce({ rows: [] }); // exception_log insert
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/55/location-check').send({ lat: 12, lng: 78 });
    expect(res.status).toBe(200);
    expect(res.body.visit.log_out_alert_sent).toBe(true);
    expect(pool.query).toHaveBeenCalledTimes(3);
  });

  test('already-alerted visit stays idempotent — no duplicate exception_log insert', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 55, dealer_id: 1, check_out_time: null, outside_radius_count: 3, log_out_alert_sent: true,
          dealer_name: 'Dealer A', dealer_lat: 11, dealer_lng: 77, radius_meters: 100,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 55, last_location_status: 'outside', outside_radius_count: 4, log_out_alert_sent: true, interrupted: true }] });
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/55/location-check').send({ lat: 12, lng: 78 });
    expect(res.status).toBe(200);
    expect(pool.query).toHaveBeenCalledTimes(2); // no new exception_log insert
  });
});

describe('GET /api/x/exceptions — manager only', () => {
  afterEach(() => jest.clearAllMocks());

  test('403 for a rep', async () => {
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).get('/api/x/exceptions');
    expect(res.status).toBe(403);
  });

  test('200 for a manager', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/exceptions');
    expect(res.status).toBe(200);
    expect(res.body.exceptions).toEqual([]);
  });
});
