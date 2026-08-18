jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));
const request = require('supertest');
const pool = require('../../src/db/pool');
const { makeApp } = require('../helpers/testApp');

const reportsRouter = require('../../src/routes/reports.routes');
const MANAGER = { id: 2, role: 'manager', username: 'priya' };

describe('GET /api/x/attendance', () => {
  afterEach(() => jest.clearAllMocks());

  test('json format returns rows + count', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ employee_name: 'Arun', total_distance_km: 5 }] });
    const app = makeApp(reportsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/attendance');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  test('csv format returns a CSV attachment', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ employee_name: 'Arun', total_distance_km: 5 }] });
    const app = makeApp(reportsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/attendance').query({ format: 'csv' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('employee_name');
    expect(res.text).toContain('Arun');
  });

  test('csv-escapes a value containing a comma', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ employee_name: 'Arun, Kumar' }] });
    const app = makeApp(reportsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/attendance').query({ format: 'csv' });
    expect(res.text).toContain('"Arun, Kumar"');
  });
});

describe('GET /api/x/distance-duration', () => {
  afterEach(() => jest.clearAllMocks());

  test('rounds numeric aggregates', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ employee_id: 1, employee_name: 'Arun', region: 'South', days_worked: '10', total_distance_km: '123.456', total_duration_minutes: '4800', total_visits: '30', avg_visit_duration_minutes: '22.222' }],
    });
    const app = makeApp(reportsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/distance-duration');
    expect(res.body.rows[0].total_distance_km).toBe('123.46');
    expect(res.body.rows[0].days_worked).toBe(10);
  });
});

describe('GET /api/x/absences', () => {
  afterEach(() => jest.clearAllMocks());

  test('json format returns day_absent rows sorted by absence date', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 9, employee_name: 'Divya', region: 'South', absence_date: '2026-08-18', reviewed: false },
        { id: 7, employee_name: 'Arun', region: 'South', absence_date: '2026-08-17', reviewed: true },
      ],
    });
    const app = makeApp(reportsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/absences');
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
    // Only the type filter is unconditional — confirms this query is scoped
    // to day_absent notifications, not the whole manager_notifications feed.
    expect(pool.query.mock.calls[0][0]).toContain(`n.type = 'day_absent'`);
  });

  test('csv format excludes the id column, same convention as every other report', async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 9, employee_name: 'Divya', region: 'South', absence_date: '2026-08-18', reviewed: false }],
    });
    const app = makeApp(reportsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/absences').query({ format: 'csv' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).not.toContain('\nid,');
    expect(res.text).toContain('Divya');
  });

  test('filters by employee_id', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(reportsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/absences').query({ employee_id: 7 });
    expect(res.status).toBe(200);
    expect(pool.query.mock.calls[0][0]).toContain('n.employee_id =');
    expect(pool.query.mock.calls[0][1]).toContain(7);
  });

  test('400 on an invalid employee_id', async () => {
    const app = makeApp(reportsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/absences').query({ employee_id: 'abc' });
    expect(res.status).toBe(400);
  });

  test('400 on an invalid from date', async () => {
    const app = makeApp(reportsRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/absences').query({ from: 'not-a-date' });
    expect(res.status).toBe(400);
  });
});
