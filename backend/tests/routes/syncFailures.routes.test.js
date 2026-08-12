jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));
const request = require('supertest');
const pool = require('../../src/db/pool');
const { makeApp } = require('../helpers/testApp');

const syncFailuresRouter = require('../../src/routes/syncFailures.routes');

const REP = { id: 1, role: 'rep', username: 'arun' };

describe('POST /api/x/', () => {
  afterEach(() => jest.clearAllMocks());

  test('400 when url is missing', async () => {
    const app = makeApp(syncFailuresRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/').send({ method: 'post' });
    expect(res.status).toBe(400);
  });

  test('201 creates a manager notification when no recent duplicate exists', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // dedup check: none found
      .mockResolvedValueOnce({ rows: [] }); // insert
    const app = makeApp(syncFailuresRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/').send({ method: 'post', url: '/notes', error: 'timeout' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(pool.query).toHaveBeenCalledTimes(2);
    const insertCall = pool.query.mock.calls[1];
    expect(insertCall[0]).toMatch(/INSERT INTO manager_notifications/);
    expect(insertCall[1][0]).toBe('sync_failure');
    expect(insertCall[1][4]).toBe(REP.id);
  });

  test('201 without a second insert when a recent duplicate already exists for this employee+endpoint', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{}] }); // dedup check: found one
    const app = makeApp(syncFailuresRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/').send({ method: 'post', url: '/notes', error: 'timeout' });

    expect(res.status).toBe(201);
    expect(res.body.deduped).toBe(true);
    expect(pool.query).toHaveBeenCalledTimes(1); // only the dedup check, no insert
  });

  test('500 when the dedup check itself fails', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));
    const app = makeApp(syncFailuresRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/').send({ method: 'post', url: '/notes' });

    expect(res.status).toBe(500);
  });

  test('escapes LIKE metacharacters in the url before building the dedup pattern', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // dedup check: none found
      .mockResolvedValueOnce({ rows: [] }); // insert
    const app = makeApp(syncFailuresRouter, { basePath: '/api/x', employee: REP });
    // A literal "%" or "_" in the url must not act as a LIKE wildcard — it
    // should be escaped so the dedup pattern matches this exact url only.
    const res = await request(app).post('/api/x/').send({ method: 'post', url: '/notes?q=100%_off', error: 'timeout' });

    expect(res.status).toBe(201);
    const dedupCall = pool.query.mock.calls[0];
    expect(dedupCall[0]).toContain("ESCAPE '\\'");
    expect(dedupCall[1][1]).toBe('%POST /notes?q=100\\%\\_off%');
  });
});
