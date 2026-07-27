jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));
const pool = require('../../src/db/pool');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_for_jest';

const { requireAuth, requireRole } = require('../../src/middleware/auth.middleware');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('requireAuth', () => {
  afterEach(() => jest.clearAllMocks());

  test('rejects a request with no Authorization header', async () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects an invalid token', async () => {
    const req = { headers: { authorization: 'Bearer not-a-real-token' } };
    const res = mockRes();
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid token' });
  });

  test('rejects a valid token for a deactivated employee', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ is_active: false }] });
    const token = jwt.sign({ sub: 1, role: 'rep', username: 'arun' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Account is deactivated' });
    expect(next).not.toHaveBeenCalled();
  });

  test('attaches req.employee and calls next for a valid, active employee', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ is_active: true }] });
    const token = jwt.sign({ sub: 42, role: 'manager', username: 'priya' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = mockRes();
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.employee).toEqual({ id: 42, role: 'manager', username: 'priya' });
  });
});

describe('requireRole', () => {
  test('403s when the employee role does not match', () => {
    const req = { employee: { id: 1, role: 'rep' } };
    const res = mockRes();
    const next = jest.fn();

    requireRole('manager')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next when the employee role matches', () => {
    const req = { employee: { id: 1, role: 'manager' } };
    const res = mockRes();
    const next = jest.fn();

    requireRole('manager')(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('401s when there is no authenticated employee', () => {
    const req = {};
    const res = mockRes();
    const next = jest.fn();

    requireRole('manager')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});
