jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));
const request = require('supertest');
const pool = require('../../src/db/pool');
const { makeApp } = require('../helpers/testApp');

const employeesRouter = require('../../src/routes/employees.routes');
const MANAGER = { id: 2, role: 'manager', username: 'priya' };

describe('POST /api/x/', () => {
  afterEach(() => jest.clearAllMocks());

  test('400 when required fields missing', async () => {
    const app = makeApp(employeesRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).post('/api/x/').send({ name: 'New Rep' });
    expect(res.status).toBe(400);
  });

  test("400 when role isn't rep or manager", async () => {
    const app = makeApp(employeesRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).post('/api/x/').send({ name: 'X', username: 'x', password: 'password1', role: 'admin' });
    expect(res.status).toBe(400);
  });

  test('400 when password too short', async () => {
    const app = makeApp(employeesRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).post('/api/x/').send({ name: 'X', username: 'x', password: '123', role: 'rep' });
    expect(res.status).toBe(400);
  });

  test('409 when username already exists', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1 }] });
    const app = makeApp(employeesRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).post('/api/x/').send({ name: 'X', username: 'arun', password: 'password1', role: 'rep' });
    expect(res.status).toBe(409);
  });

  test('201 creates a new employee', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // existing check
      .mockResolvedValueOnce({ rows: [{ id: 3, name: 'New Rep', username: 'new.rep', role: 'rep' }] }); // insert
    const app = makeApp(employeesRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).post('/api/x/').send({ name: 'New Rep', username: 'new.rep', password: 'password1', role: 'rep' });
    expect(res.status).toBe(201);
    expect(res.body.employee.username).toBe('new.rep');
  });
});

describe('POST /api/x/:id/reset-password', () => {
  afterEach(() => jest.clearAllMocks());

  test('400 when password too short', async () => {
    const app = makeApp(employeesRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).post('/api/x/3/reset-password').send({ password: '123' });
    expect(res.status).toBe(400);
  });

  test('404 when the employee does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(employeesRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).post('/api/x/999/reset-password').send({ password: 'newpassword1' });
    expect(res.status).toBe(404);
  });

  test('200 on success', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 3 }] });
    const app = makeApp(employeesRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).post('/api/x/3/reset-password').send({ password: 'newpassword1' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
