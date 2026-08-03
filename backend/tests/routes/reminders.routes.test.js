jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));
const request = require('supertest');
const pool = require('../../src/db/pool');
const { makeApp } = require('../helpers/testApp');

const remindersRouter = require('../../src/routes/reminders.routes');

const REP = { id: 1, role: 'rep', username: 'arun' };
const OTHER_REP = { id: 2, role: 'rep', username: 'divya' };
const MANAGER = { id: 99, role: 'manager', username: 'priya' };

const LONG_NOTE = 'Follow up on the pending order and payment';
const SHORT_NOTE = 'too short';
const FUTURE_DATE = '2099-01-01';
const PAST_DATE = '2000-01-01';

describe('POST /api/x/', () => {
  afterEach(() => jest.clearAllMocks());

  test('400 when dealer_id is not an integer', async () => {
    const app = makeApp(remindersRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/').send({ dealer_id: 'abc', reminder_date: FUTURE_DATE, note: LONG_NOTE });
    expect(res.status).toBe(400);
  });

  test('400 when reminder_date is not a valid date', async () => {
    const app = makeApp(remindersRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/').send({ dealer_id: 2, reminder_date: 'not-a-date', note: LONG_NOTE });
    expect(res.status).toBe(400);
  });

  test('422 when reminder_date is in the past', async () => {
    const app = makeApp(remindersRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/').send({ dealer_id: 2, reminder_date: PAST_DATE, note: LONG_NOTE });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('reminder_date_in_past');
  });

  test('422 when note is under 20 characters', async () => {
    const app = makeApp(remindersRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/').send({ dealer_id: 2, reminder_date: FUTURE_DATE, note: SHORT_NOTE });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('note_too_short');
  });

  test('404 when the dealer does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(remindersRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/').send({ dealer_id: 999, reminder_date: FUTURE_DATE, note: LONG_NOTE });
    expect(res.status).toBe(404);
  });

  test('201 creates a reminder for the authenticated employee', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 2 }] }) // dealer exists
      .mockResolvedValueOnce({ rows: [{ id: 5, employee_id: REP.id, dealer_id: 2, reminder_date: FUTURE_DATE, note: LONG_NOTE }] });
    const app = makeApp(remindersRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).post('/api/x/').send({ dealer_id: 2, reminder_date: FUTURE_DATE, note: LONG_NOTE });
    expect(res.status).toBe(201);
    expect(res.body.reminder.id).toBe(5);
    expect(pool.query.mock.calls[1][1]).toEqual([REP.id, 2, FUTURE_DATE, LONG_NOTE]);
  });
});

describe('GET /api/x/', () => {
  afterEach(() => jest.clearAllMocks());

  test("200 lists the caller's own reminders with dealer name", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, employee_id: REP.id, dealer_id: 2, dealer_name: 'Anand Tiles', note: LONG_NOTE }] });
    const app = makeApp(remindersRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).get('/api/x/');
    expect(res.status).toBe(200);
    expect(res.body.reminders).toHaveLength(1);
    expect(res.body.reminders[0].dealer_name).toBe('Anand Tiles');
    expect(pool.query.mock.calls[0][1]).toEqual([REP.id]);
  });

  test('a manager can pass ?employee_id= to view a rep\'s reminders', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(remindersRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/').query({ employee_id: REP.id });
    expect(res.status).toBe(200);
    expect(pool.query.mock.calls[0][1]).toEqual([REP.id]);
  });

  test('400 when a manager passes an invalid employee_id', async () => {
    const app = makeApp(remindersRouter, { basePath: '/api/x', employee: MANAGER });
    const res = await request(app).get('/api/x/').query({ employee_id: 'abc' });
    expect(res.status).toBe(400);
  });

  test('a rep passing ?employee_id= is ignored — still sees only their own', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(remindersRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).get('/api/x/').query({ employee_id: OTHER_REP.id });
    expect(res.status).toBe(200);
    expect(pool.query.mock.calls[0][1]).toEqual([REP.id]);
  });
});

describe('PATCH /api/x/:id/notifications', () => {
  afterEach(() => jest.clearAllMocks());

  test('404 when reminder does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(remindersRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).patch('/api/x/5/notifications').send({ notif_id_day_before: 'a', notif_id_day_of: 'b' });
    expect(res.status).toBe(404);
  });

  test("403 when a rep edits another rep's reminder", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ employee_id: OTHER_REP.id }] });
    const app = makeApp(remindersRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).patch('/api/x/5/notifications').send({ notif_id_day_before: 'a', notif_id_day_of: 'b' });
    expect(res.status).toBe(403);
  });

  test('200 persists the notification ids', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ employee_id: REP.id }] })
      .mockResolvedValueOnce({ rows: [{ id: 5, notif_id_day_before: 'a', notif_id_day_of: 'b' }] });
    const app = makeApp(remindersRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).patch('/api/x/5/notifications').send({ notif_id_day_before: 'a', notif_id_day_of: 'b' });
    expect(res.status).toBe(200);
    expect(res.body.reminder.notif_id_day_before).toBe('a');
  });
});

describe('DELETE /api/x/:id', () => {
  afterEach(() => jest.clearAllMocks());

  test('404 when reminder does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp(remindersRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).delete('/api/x/5');
    expect(res.status).toBe(404);
  });

  test("403 when a rep deletes another rep's reminder", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ employee_id: OTHER_REP.id }] });
    const app = makeApp(remindersRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).delete('/api/x/5');
    expect(res.status).toBe(403);
  });

  test('200 deletes the reminder', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ employee_id: REP.id }] })
      .mockResolvedValueOnce({ rows: [] });
    const app = makeApp(remindersRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).delete('/api/x/5');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
