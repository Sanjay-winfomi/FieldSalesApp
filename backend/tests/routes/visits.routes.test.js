jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));
const request = require('supertest');
const pool = require('../../src/db/pool');
const { makeApp } = require('../helpers/testApp');

const visitsRouter = require('../../src/routes/visits.routes');

const REP = { id: 1, role: 'rep', username: 'arun' };
const MANAGER = { id: 2, role: 'manager', username: 'priya' };

describe('POST /api/x/login', () => {
  // resetAllMocks (not clearAllMocks) — clearAllMocks leaves any UNCONSUMED
  // mockResolvedValueOnce entries queued, which then leak into the next
  // test and silently shift its call order. resetAllMocks actually empties
  // that queue between tests.
  afterEach(() => jest.resetAllMocks());

  test('400 when required fields are missing', async () => {
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/login').send({ dealer_id: 1 });
    expect(res.status).toBe(400);
  });

  test('422 when GPS accuracy exceeds the threshold', async () => {
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app)
      .post('/api/x/login')
      .send({ attendance_id: 1, dealer_id: 1, lat: 11, lng: 77, accuracy_meters: 999 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('gps_accuracy_exceeded');
  });

  test('422 with reason_required when outside radius and no reason given', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, login_lat: 11, login_lng: 77 }] }) // attendance
      .mockResolvedValueOnce({ rows: [] }) // no open visit
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Dealer A', latitude: 11, longitude: 77, radius_meters: 100 }] }); // dealer
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app)
      .post('/api/x/login')
      .send({ attendance_id: 1, dealer_id: 1, lat: 12, lng: 78, accuracy_meters: 10 }); // ~150km away
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('reason_required');
  });

  test('201 logs in successfully inside the radius', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, login_lat: 11, login_lng: 77 }] }) // attendance
      .mockResolvedValueOnce({ rows: [] }) // no open visit
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'Dealer A', latitude: 11, longitude: 77, radius_meters: 200 }] }) // dealer
      .mockResolvedValueOnce({ rows: [] }) // last visit (none)
      .mockResolvedValueOnce({ rows: [{ id: 55, dealer_id: 1, login_time: 'now', login_lat: 11, login_lng: 77 }] }) // insert visit
      .mockResolvedValueOnce({ rows: [] }); // update attendance distance
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app)
      .post('/api/x/login')
      .send({ attendance_id: 1, dealer_id: 1, lat: 11, lng: 77, accuracy_meters: 10 });
    expect(res.status).toBe(201);
    expect(res.body.visit.id).toBe(55);
    expect(res.body.visit.dealer_name).toBe('Dealer A');
  });

  test('404 when the dealer does not exist', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, login_lat: 11, login_lng: 77 }] })
      .mockResolvedValueOnce({ rows: [] }) // no open visit
      .mockResolvedValueOnce({ rows: [] });
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app)
      .post('/api/x/login')
      .send({ attendance_id: 1, dealer_id: 999, lat: 11, lng: 77, accuracy_meters: 10 });
    expect(res.status).toBe(404);
  });

  test('409 visit_already_open when the rep already has an open visit for this attendance', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, login_lat: 11, login_lng: 77 }] }) // attendance
      .mockResolvedValueOnce({ rows: [{ id: 55, dealer_id: 2, dealer_name: 'Dealer B' }] }); // open visit found
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app)
      .post('/api/x/login')
      .send({ attendance_id: 1, dealer_id: 1, lat: 11, lng: 77, accuracy_meters: 10 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('visit_already_open');
    expect(res.body.visit).toEqual({ id: 55, dealer_id: 2, dealer_name: 'Dealer B' });
  });
});

describe('POST /api/x/logout', () => {
  afterEach(() => jest.resetAllMocks());

  test('409 with the authoritative visit record when already logged out', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 55, attendance_id: 1, dealer_id: 1,
        login_time: '2026-07-27T05:00:00Z', logout_time: '2026-07-27T06:00:00Z',
        login_lat: 11, login_lng: 77,
        dealer_name: 'Dealer A', dealer_lat: 11, dealer_lng: 77, dealer_radius_meters: 200,
      }],
    });
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/logout').send({ visit_id: 55, lat: 11, lng: 77, accuracy_meters: 10 });
    expect(res.status).toBe(409);
    expect(res.body.visit).toEqual({ id: 55, logout_time: '2026-07-27T06:00:00Z' });
  });

  test('200 logs out successfully inside the radius', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 55, attendance_id: 1, dealer_id: 1,
          login_time: '2026-07-27T05:00:00Z', logout_time: null,
          login_lat: 11, login_lng: 77, login_inside_radius: true,
          dealer_name: 'Dealer A', dealer_lat: 11, dealer_lng: 77, dealer_radius_meters: 200,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 55, logout_time: 'now', visit_duration_minutes: 30, out_of_radius: false, matched_login: false }] });
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/logout').send({ visit_id: 55, lat: 11, lng: 77, accuracy_meters: 10 });
    expect(res.status).toBe(200);
    expect(res.body.visit.out_of_radius).toBe(false);
    expect(res.body.visit.needs_verification).toBe(false);
  });

  // Task 5 Case 1 — a normal (non-exception) login, logging out from
  // outside the dealer radius and not drift-matched to the login spot,
  // requires a written reason (50-500 chars) instead of a hard reject.
  test('422 reason_required for a normal-login visit outside radius with no reason given', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 55, attendance_id: 1, dealer_id: 1,
        login_time: '2026-07-27T05:00:00Z', logout_time: null,
        login_lat: 11, login_lng: 77, login_inside_radius: true,
        dealer_name: 'Dealer A', dealer_lat: 11, dealer_lng: 77, dealer_radius_meters: 100,
      }],
    });
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app)
      .post('/api/x/logout')
      .send({ visit_id: 55, lat: 12, lng: 78, accuracy_meters: 10 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('reason_required');
    expect(res.body.minLength).toBe(50);
    expect(res.body.maxLength).toBe(500);
  });

  test('200 logs out a normal-login visit from outside radius once a valid reason (50-500 chars) is given', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 55, attendance_id: 1, dealer_id: 1,
          login_time: '2026-07-27T05:00:00Z', logout_time: null,
          login_lat: 11, login_lng: 77, login_inside_radius: true,
          dealer_name: 'Dealer A', dealer_lat: 11, dealer_lng: 77, dealer_radius_meters: 100,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 55, logout_time: 'now', visit_duration_minutes: 30, out_of_radius: true, matched_login: false }] })
      .mockResolvedValueOnce({ rows: [] }) // exception_log insert
      .mockResolvedValueOnce({ rows: [] }); // createManagerNotification's insert
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app)
      .post('/api/x/logout')
      .send({ visit_id: 55, lat: 12, lng: 78, accuracy_meters: 10, reason: 'A perfectly long, valid-looking reason string here' });
    expect(res.status).toBe(200);
    expect(res.body.visit.out_of_radius).toBe(true);
  });

  // Task 5 Case 2 — login already used an exception: logout always requires
  // a written reason (50-500 chars), regardless of current distance.
  test('422 reason_required (50-500 chars) for an exception-login visit, even inside radius', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 55, attendance_id: 1, dealer_id: 1,
        login_time: '2026-07-27T05:00:00Z', logout_time: null,
        login_lat: 11, login_lng: 77, login_inside_radius: false,
        dealer_name: 'Dealer A', dealer_lat: 11, dealer_lng: 77, dealer_radius_meters: 200,
      }],
    });
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app)
      .post('/api/x/logout')
      .send({ visit_id: 55, lat: 11, lng: 77, accuracy_meters: 10, reason: 'too short' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('reason_required');
    expect(res.body.minLength).toBe(50);
    expect(res.body.maxLength).toBe(500);
  });

  // Task 5 Case 3 — exception at BOTH login and logout is flagged for the
  // manager dashboard's "Needs Verification" status.
  test('needs_verification is true when both login and logout used an exception', async () => {
    const longReason = 'x'.repeat(60);
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 55, attendance_id: 1, dealer_id: 1,
          login_time: '2026-07-27T05:00:00Z', logout_time: null,
          login_lat: 11, login_lng: 77, login_inside_radius: false,
          dealer_name: 'Dealer A', dealer_lat: 11, dealer_lng: 77, dealer_radius_meters: 100,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 55, logout_time: 'now', visit_duration_minutes: 30, out_of_radius: true, matched_login: false }] })
      .mockResolvedValueOnce({ rows: [] }) // exception_log insert
      .mockResolvedValueOnce({ rows: [] }); // createManagerNotification's insert
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app)
      .post('/api/x/logout')
      .send({ visit_id: 55, lat: 12, lng: 78, accuracy_meters: 10, reason: longReason });
    expect(res.status).toBe(200);
    expect(res.body.visit.needs_verification).toBe(true);
  });
});

describe('POST /api/x/:id/location-check', () => {
  afterEach(() => jest.resetAllMocks());

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
          id: 55, dealer_id: 1, logout_time: null, outside_radius_count: 0, log_out_alert_sent: false,
          dealer_name: 'Dealer A', dealer_lat: 11, dealer_lng: 77, radius_meters: 200, employee_name: 'Arun',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 55, last_location_status: 'inside', outside_radius_count: 0, log_out_alert_sent: false, interrupted: false }] })
      .mockResolvedValueOnce({ rows: [] }); // visit_radius_events open-event lookup — none, inside, nothing else to do
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/55/location-check').send({ lat: 11, lng: 77 });
    expect(res.status).toBe(200);
    expect(res.body.visit.last_location_status).toBe('inside');
    expect(pool.query).toHaveBeenCalledTimes(3); // select, update, radius-events lookup — no exception_log insert
  });

  test('one breach: increments count but does not yet trigger the logout alert', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 55, dealer_id: 1, logout_time: null, outside_radius_count: 0, log_out_alert_sent: false,
          dealer_name: 'Dealer A', dealer_lat: 11, dealer_lng: 77, radius_meters: 100, employee_name: 'Arun',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 55, last_location_status: 'outside', outside_radius_count: 1, log_out_alert_sent: false, interrupted: false }] })
      .mockResolvedValueOnce({ rows: [] }) // visit_radius_events open-event lookup — none yet
      .mockResolvedValueOnce({ rows: [] }); // visit_radius_events insert — excursion starts, no alert on first check
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/55/location-check').send({ lat: 12, lng: 78 }); // ~150km away
    expect(res.status).toBe(200);
    expect(res.body.visit.outside_radius_count).toBe(1);
    expect(res.body.visit.log_out_alert_sent).toBe(false);
    expect(pool.query).toHaveBeenCalledTimes(4); // still no exception_log insert
  });

  test('second breach (non-consecutive) trips the logout alert and logs an exception', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 55, dealer_id: 1, logout_time: null, outside_radius_count: 1, log_out_alert_sent: false,
          dealer_name: 'Dealer A', dealer_lat: 11, dealer_lng: 77, radius_meters: 100, employee_name: 'Arun',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 55, last_location_status: 'outside', outside_radius_count: 2, log_out_alert_sent: true, interrupted: true }] })
      .mockResolvedValueOnce({ rows: [] }) // exception_log insert
      .mockResolvedValueOnce({ rows: [] }) // visit_radius_events open-event lookup — non-consecutive, so no open excursion right now
      .mockResolvedValueOnce({ rows: [] }); // visit_radius_events insert — new excursion starts
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/55/location-check').send({ lat: 12, lng: 78 });
    expect(res.status).toBe(200);
    expect(res.body.visit.log_out_alert_sent).toBe(true);
    expect(pool.query).toHaveBeenCalledTimes(5);
  });

  test('already-alerted visit stays idempotent — no duplicate exception_log insert', async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{
          id: 55, dealer_id: 1, logout_time: null, outside_radius_count: 3, log_out_alert_sent: true,
          dealer_name: 'Dealer A', dealer_lat: 11, dealer_lng: 77, radius_meters: 100, employee_name: 'Arun',
        }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 55, last_location_status: 'outside', outside_radius_count: 4, log_out_alert_sent: true, interrupted: true }] })
      // Open excursion already tracked, just started (left_at ~now) — dueStage
      // is still 0 so no new alert fires, just the max-distance/count update.
      .mockResolvedValueOnce({ rows: [{ id: 9, left_at: new Date().toISOString(), alert_count: 0, max_distance_m: 100 }] })
      .mockResolvedValueOnce({ rows: [] }); // visit_radius_events update
    const app = makeApp(visitsRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/55/location-check').send({ lat: 12, lng: 78 });
    expect(res.status).toBe(200);
    expect(pool.query).toHaveBeenCalledTimes(4); // no new exception_log insert
  });
});

describe('GET /api/x/exceptions — manager only', () => {
  afterEach(() => jest.resetAllMocks());

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
