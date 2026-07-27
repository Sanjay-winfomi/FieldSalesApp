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
