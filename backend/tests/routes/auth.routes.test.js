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
