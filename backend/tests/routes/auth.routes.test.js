jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));
const request = require('supertest');
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../../src/db/pool');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_jest';

const authRouter = require('../../src/routes/auth.routes');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  return app;
}

describe('POST /api/auth/login', () => {
  afterEach(() => jest.clearAllMocks());

  test('400 when username/password missing', async () => {
    const res = await request(makeApp()).post('/api/auth/login').send({ username: 'arun' });
    expect(res.status).toBe(400);
  });

  test('401 with a generic message when the username does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(makeApp()).post('/api/auth/login').send({ username: 'nobody', password: 'x' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Username not found');
  });

  test('401 when the employee is deactivated', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, is_active: false, password_hash: 'x' }] });
    const res = await request(makeApp()).post('/api/auth/login').send({ username: 'arun', password: 'x' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Username not found');
  });

  test('401 on wrong password', async () => {
    const hash = await bcrypt.hash('correct-password', 10);
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, is_active: true, password_hash: hash, role: 'rep' }] });
    const res = await request(makeApp()).post('/api/auth/login').send({ username: 'arun', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Incorrect password');
  });

  test('200 with access + refresh tokens on success', async () => {
    const hash = await bcrypt.hash('correct-password', 10);
    pool.query.mockResolvedValueOnce({
      rows: [{ id: 1, name: 'Arun Kumar', username: 'arun.kumar', password_hash: hash, role: 'rep', region: 'South', is_active: true }],
    });
    const res = await request(makeApp()).post('/api/auth/login').send({ username: 'arun.kumar', password: 'correct-password' });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.employee.username).toBe('arun.kumar');
    expect(res.body.employee.password_hash).toBeUndefined();
  });
});

describe('POST /api/auth/refresh', () => {
  afterEach(() => jest.clearAllMocks());

  test('400 when refreshToken missing', async () => {
    const res = await request(makeApp()).post('/api/auth/refresh').send({});
    expect(res.status).toBe(400);
  });

  test('401 on a garbage refresh token', async () => {
    const res = await request(makeApp()).post('/api/auth/refresh').send({ refreshToken: 'garbage' });
    expect(res.status).toBe(401);
  });

  test('401 when the refresh token is an access token, not a refresh token', async () => {
    const jwt = require('jsonwebtoken');
    const accessToken = jwt.sign({ sub: 1, role: 'rep', username: 'arun' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const res = await request(makeApp()).post('/api/auth/refresh').send({ refreshToken: accessToken });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid refresh token');
  });

  test('200 with a new access token for a valid refresh token', async () => {
    const jwt = require('jsonwebtoken');
    const refreshToken = jwt.sign({ sub: 7, type: 'refresh' }, process.env.JWT_SECRET, { expiresIn: '7d' });
    pool.query.mockResolvedValueOnce({ rows: [{ id: 7, name: 'Priya', username: 'priya', role: 'manager', region: 'North', is_active: true }] });

    const res = await request(makeApp()).post('/api/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });
});

describe('POST /api/auth/forgot-password', () => {
  afterEach(() => jest.clearAllMocks());

  test('400 when a required field is missing', async () => {
    const res = await request(makeApp()).post('/api/auth/forgot-password').send({ username: 'arun', phone: '9876543210' });
    expect(res.status).toBe(400);
  });

  test('400 when new_password is under 6 characters', async () => {
    const res = await request(makeApp()).post('/api/auth/forgot-password')
      .send({ username: 'arun', phone: '9876543210', new_password: 'abc' });
    expect(res.status).toBe(400);
  });

  test('401 with a generic message when the username does not exist', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(makeApp()).post('/api/auth/forgot-password')
      .send({ username: 'nobody', phone: '9876543210', new_password: 'newpass1' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Username not found');
  });

  test('401 when the employee is deactivated', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, phone: '9876543210', is_active: false }] });
    const res = await request(makeApp()).post('/api/auth/forgot-password')
      .send({ username: 'arun', phone: '9876543210', new_password: 'newpass1' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Username not found');
  });

  test('401 when the phone number does not match', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, phone: '9876543210', is_active: true }] });
    const res = await request(makeApp()).post('/api/auth/forgot-password')
      .send({ username: 'arun', phone: '9999999999', new_password: 'newpass1' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Phone number does not match our records');
  });

  test('401 when no phone is on file for the account', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 1, phone: null, is_active: true }] });
    const res = await request(makeApp()).post('/api/auth/forgot-password')
      .send({ username: 'arun', phone: '9876543210', new_password: 'newpass1' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Phone number does not match our records');
  });

  test('matches a phone number with different formatting (spaces, country code)', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, phone: '98765 43210', is_active: true }] })
      .mockResolvedValueOnce({});
    const res = await request(makeApp()).post('/api/auth/forgot-password')
      .send({ username: 'arun', phone: '+91-9876543210', new_password: 'newpass1' });
    expect(res.status).toBe(200);
  });

  test('200 hashes and persists the new password on success', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 42, phone: '9876543210', is_active: true }] })
      .mockResolvedValueOnce({});
    const res = await request(makeApp()).post('/api/auth/forgot-password')
      .send({ username: 'arun.kumar', phone: '9876543210', new_password: 'newpass1' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const [updateSql, updateParams] = pool.query.mock.calls[1];
    expect(updateSql).toMatch(/UPDATE employees SET password_hash/);
    expect(updateParams[1]).toBe(42);
    const bcrypt = require('bcryptjs');
    expect(await bcrypt.compare('newpass1', updateParams[0])).toBe(true);
  });
});
