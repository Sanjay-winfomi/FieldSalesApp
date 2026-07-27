import { describe, test, expect, vi, beforeEach } from 'vitest';
import { apiClient, setAuthToken, setSessionExpiredHandler } from '../api';

describe('apiClient request interceptor', () => {
  beforeEach(() => setAuthToken(null));

  test('attaches the Authorization header when a token is set', async () => {
    setAuthToken('abc123');
    const config = await apiClient.interceptors.request.handlers[0].fulfilled({ headers: {} });
    expect(config.headers.Authorization).toBe('Bearer abc123');
  });

  test('does not attach a header when no token is set', async () => {
    const config = await apiClient.interceptors.request.handlers[0].fulfilled({ headers: {} });
    expect(config.headers.Authorization).toBeUndefined();
  });
});

describe('apiClient response interceptor', () => {
  test('calls the session-expired handler on a 401', async () => {
    const handler = vi.fn();
    setSessionExpiredHandler(handler);

    await expect(
      apiClient.interceptors.response.handlers[0].rejected({ response: { status: 401 } })
    ).rejects.toBeDefined();

    expect(handler).toHaveBeenCalled();
    setSessionExpiredHandler(null);
  });

  test('does not call the handler for a non-401 error', async () => {
    const handler = vi.fn();
    setSessionExpiredHandler(handler);

    await expect(
      apiClient.interceptors.response.handlers[0].rejected({ response: { status: 500 } })
    ).rejects.toBeDefined();

    expect(handler).not.toHaveBeenCalled();
    setSessionExpiredHandler(null);
  });
});
