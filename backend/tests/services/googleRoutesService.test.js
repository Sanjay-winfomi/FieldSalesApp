const ORIGINAL_ENV = process.env.GOOGLE_MAPS_API_KEY;

describe('googleRoutesService.computeRoute', () => {
  let computeRoute;

  beforeEach(() => {
    jest.resetModules();
    process.env.GOOGLE_MAPS_API_KEY = 'test-key';
    global.fetch = jest.fn();
    global.AbortSignal = { timeout: jest.fn(() => 'signal') };
    ({ computeRoute } = require('../../src/services/googleRoutesService'));
  });

  afterEach(() => {
    process.env.GOOGLE_MAPS_API_KEY = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  const ROUTE_ARGS = { originLat: 12.9, originLng: 77.6, destLat: 13.0, destLng: 77.7 };

  test('parses a successful response into distance/duration/polyline', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        routes: [{
          distanceMeters: 5200,
          duration: '620s',
          staticDuration: '580s',
          polyline: { encodedPolyline: 'abc123' },
        }],
      }),
    });

    const result = await computeRoute(ROUTE_ARGS);

    expect(result.distanceMeters).toBe(5200);
    expect(result.durationSeconds).toBe(620);
    expect(result.staticDurationSeconds).toBe(580);
    expect(result.encodedPolyline).toBe('abc123');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toContain('computeRoutes');
    expect(options.headers['X-Goog-Api-Key']).toBe('test-key');
    expect(JSON.parse(options.body).computeAlternativeRoutes).toBe(false);
  });

  test('does not retry a genuine 4xx (e.g. bad request)', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'invalid argument' } }),
    });

    await expect(computeRoute(ROUTE_ARGS)).rejects.toThrow(/Routes API error 400/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('retries once on a 503 and succeeds on the second attempt', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ routes: [{ distanceMeters: 100, duration: '60s', polyline: {} }] }),
      });

    const result = await computeRoute(ROUTE_ARGS);

    expect(result.distanceMeters).toBe(100);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('throws when GOOGLE_MAPS_API_KEY is not configured', async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    await expect(computeRoute(ROUTE_ARGS)).rejects.toThrow(/GOOGLE_MAPS_API_KEY/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('throws a non-retryable error when Google returns no route', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ routes: [] }) });

    await expect(computeRoute(ROUTE_ARGS)).rejects.toThrow(/no route/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
