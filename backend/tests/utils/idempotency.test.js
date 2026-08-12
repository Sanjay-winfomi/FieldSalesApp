jest.mock('../../src/db/pool', () => ({ query: jest.fn() }));
const pool = require('../../src/db/pool');
const { getIdempotentResponse, saveIdempotentResponse, cleanupOldIdempotencyKeys } = require('../../src/utils/idempotency');

describe('idempotency', () => {
  afterEach(() => jest.resetAllMocks());

  test('getIdempotentResponse returns null without hitting the DB when no key is given', async () => {
    const result = await getIdempotentResponse(null, 1);
    expect(result).toBeNull();
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('saveIdempotentResponse is a no-op without hitting the DB when no key is given', async () => {
    await saveIdempotentResponse(null, 1, 'visits/login', 201, { ok: true });
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('getIdempotentResponse scopes the lookup by employee_id, not just the key', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ response_status: 201, response_body: { ok: true } }] });
    const result = await getIdempotentResponse('abc', 42);
    expect(result).toEqual({ response_status: 201, response_body: { ok: true } });
    expect(pool.query.mock.calls[0][1]).toEqual(['abc', 42]);
  });

  test('cleanupOldIdempotencyKeys deletes rows older than the retention window', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await cleanupOldIdempotencyKeys();
    expect(pool.query.mock.calls[0][0]).toContain('DELETE FROM idempotency_keys');
    expect(pool.query.mock.calls[0][0]).toContain("created_at < NOW() - INTERVAL");
  });

  test('cleanupOldIdempotencyKeys swallows errors instead of throwing', async () => {
    pool.query.mockRejectedValueOnce(new Error('db down'));
    await expect(cleanupOldIdempotencyKeys()).resolves.toBeUndefined();
  });
});
