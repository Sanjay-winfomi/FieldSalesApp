jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));
const request = require('supertest');
const pool = require('../../src/db/pool');
const { makeApp } = require('../helpers/testApp');

const notesRouter = require('../../src/routes/notes.routes');

const REP = { id: 1, role: 'rep', username: 'arun' };
const OTHER_REP = { id: 2, role: 'rep', username: 'divya' };
const MANAGER = { id: 99, role: 'manager', username: 'priya' };

const LONG_CONTENT = 'a'.repeat(100);
const SHORT_CONTENT = 'too short';

describe('POST /api/x/', () => {
  afterEach(() => jest.clearAllMocks());

  test('422 when content is under 100 characters', async () => {
    const app = makeApp(notesRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/').send({ content: SHORT_CONTENT });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('content_too_short');
  });

  test('422 when content is missing', async () => {
    const app = makeApp(notesRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/').send({});
    expect(res.status).toBe(422);
  });

  test('201 creates a note for the authenticated employee', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 5, employee_id: REP.id, content: LONG_CONTENT }] });
    const app = makeApp(notesRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/').send({ content: LONG_CONTENT });
    expect(res.status).toBe(201);
    expect(res.body.note.id).toBe(5);
    expect(pool.query.mock.calls[0][1]).toEqual([REP.id, LONG_CONTENT]);
  });
});

describe('GET /api/x/', () => {
  afterEach(() => jest.clearAllMocks());

  test("200 lists the caller's own notes", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, employee_id: REP.id, content: LONG_CONTENT }] });
    const app = makeApp(notesRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).get('/api/x/');
    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
    expect(pool.query.mock.calls[0][1]).toEqual([REP.id]);
  });

  test("manager can pass ?employee_id= to view a rep's notes", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(notesRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/').query({ employee_id: REP.id });
    expect(res.status).toBe(200);
    expect(pool.query.mock.calls[0][1]).toEqual([REP.id]);
  });
});

describe('GET /api/x/:id', () => {
  afterEach(() => jest.clearAllMocks());

  test('404 when note does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(notesRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).get('/api/x/5');
    expect(res.status).toBe(404);
  });

  test("403 when a rep requests another rep's note", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 5, employee_id: OTHER_REP.id, content: LONG_CONTENT }] });
    const app = makeApp(notesRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).get('/api/x/5');
    expect(res.status).toBe(403);
  });

  test('200 when a manager requests any note', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 5, employee_id: REP.id, content: LONG_CONTENT }] });
    const app = makeApp(notesRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/5');
    expect(res.status).toBe(200);
  });
});

describe('PUT /api/x/:id', () => {
  afterEach(() => jest.clearAllMocks());

  test('422 when new content is under 100 characters', async () => {
    const app = makeApp(notesRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).put('/api/x/5').send({ content: SHORT_CONTENT });
    expect(res.status).toBe(422);
  });

  test('404 when note does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(notesRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).put('/api/x/5').send({ content: LONG_CONTENT });
    expect(res.status).toBe(404);
  });

  test("403 when a rep edits another rep's note", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ employee_id: OTHER_REP.id }] });
    const app = makeApp(notesRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).put('/api/x/5').send({ content: LONG_CONTENT });
    expect(res.status).toBe(403);
  });

  test('200 updates the note content', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ employee_id: REP.id }] })
      .mockResolvedValueOnce({ rows: [{ id: 5, employee_id: REP.id, content: LONG_CONTENT }] });
    const app = makeApp(notesRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).put('/api/x/5').send({ content: LONG_CONTENT });
    expect(res.status).toBe(200);
    expect(res.body.note.content).toBe(LONG_CONTENT);
  });
});

describe('DELETE /api/x/:id', () => {
  afterEach(() => jest.clearAllMocks());

  test('404 when note does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(notesRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).delete('/api/x/5');
    expect(res.status).toBe(404);
  });

  test("403 when a rep deletes another rep's note", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ employee_id: OTHER_REP.id }] });
    const app = makeApp(notesRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).delete('/api/x/5');
    expect(res.status).toBe(403);
  });

  test('200 deletes the note', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ employee_id: REP.id }] })
      .mockResolvedValueOnce({ rows: [] });
    const app = makeApp(notesRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).delete('/api/x/5');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
