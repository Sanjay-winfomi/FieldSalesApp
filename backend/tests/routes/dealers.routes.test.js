jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));
const request = require('supertest');
const pool = require('../../src/db/pool');
const { makeApp } = require('../helpers/testApp');

const dealersRouter = require('../../src/routes/dealers.routes');

const REP = { id: 1, role: 'rep', username: 'arun' };
const MANAGER = { id: 2, role: 'manager', username: 'priya' };

describe('GET /api/x/', () => {
  afterEach(() => jest.clearAllMocks());

  test('200 lists dealers', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'Dealer A' }] });
    const app = makeApp(dealersRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).get('/api/x/');
    expect(res.status).toBe(200);
    expect(res.body.dealers).toHaveLength(1);
  });

  test('escapes LIKE metacharacters in ?search=', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(dealersRouter, { basePath: '/api/x', employee: REP });
    await request(app).get('/api/x/').query({ search: '100% Fresh_Mart' });
    const [, params] = pool.query.mock.calls[0];
    expect(params[0]).toBe('%100\\% Fresh\\_Mart%');
  });
});

describe('POST /api/x/ — manager only', () => {
  afterEach(() => jest.clearAllMocks());

  test('403 for a rep', async () => {
    const app = makeApp(dealersRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/').send({ name: 'New Dealer' });
    expect(res.status).toBe(403);
  });

  test('400 when name missing', async () => {
    const app = makeApp(dealersRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).post('/api/x/').send({});
    expect(res.status).toBe(400);
  });

  test('201 creates a dealer with default radius', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 10, name: 'New Dealer', radius_meters: 200 }] });
    const app = makeApp(dealersRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).post('/api/x/').send({ name: 'New Dealer' });
    expect(res.status).toBe(201);
    expect(res.body.dealer.radius_meters).toBe(200);
  });
});

describe('PUT /api/x/:id — manager only', () => {
  afterEach(() => jest.clearAllMocks());

  test('404 when dealer does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(dealersRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).put('/api/x/999').send({ name: 'X' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/x/:id — manager only', () => {
  afterEach(() => jest.clearAllMocks());

  test('403 for a rep', async () => {
    const app = makeApp(dealersRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).delete('/api/x/1');
    expect(res.status).toBe(403);
  });

  test('404 when dealer does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(dealersRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).delete('/api/x/999');
    expect(res.status).toBe(404);
  });

  test('409 when the dealer has recorded visits', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // existence check
      .mockResolvedValueOnce({ rows: [{ count: 3 }] }); // visit count
    const app = makeApp(dealersRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).delete('/api/x/1');
    expect(res.status).toBe(409);
  });

  test('200 deletes a dealer with no recorded visits', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1 }] }) // existence check
      .mockResolvedValueOnce({ rows: [{ count: 0 }] }) // visit count
      .mockResolvedValueOnce({ rows: [] }); // delete
    const app = makeApp(dealersRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).delete('/api/x/1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
