const request = require('supertest');
const { makeApp } = require('../helpers/testApp');

process.env.GOOGLE_MAPS_API_KEY = 'test-key';
const geocodeRouter = require('../../src/routes/geocode.routes');
const REP = { id: 1, role: 'rep', username: 'arun' };

function mockFetchOnce(json, ok = true) {
  global.fetch = jest.fn().mockResolvedValueOnce({
    ok,
    status: ok ? 200 : 500,
    json: async () => json,
  });
}

describe('GET /api/x/search', () => {
  afterEach(() => jest.restoreAllMocks());

  test('400 when q missing', async () => {
    const app = makeApp(geocodeRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).get('/api/x/search');
    expect(res.status).toBe(400);
  });

  test('returns candidates on a successful lookup', async () => {
    mockFetchOnce({
      status: 'OK',
      results: [{ geometry: { location: { lat: 11.01, lng: 76.95 } }, formatted_address: 'Coimbatore, TN' }],
    });
    const app = makeApp(geocodeRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).get('/api/x/search').query({ q: 'Coimbatore' });
    expect(res.status).toBe(200);
    expect(res.body.found).toBe(true);
    expect(res.body.candidates[0].display_name).toBe('Coimbatore, TN');
  });

  test('502 when the upstream API call fails', async () => {
    global.fetch = jest.fn().mockRejectedValueOnce(new Error('network down'));
    const app = makeApp(geocodeRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).get('/api/x/search').query({ q: 'Nowhere' });
    expect(res.status).toBe(502);
  });
});

describe('GET /api/x/autocomplete', () => {
  afterEach(() => jest.restoreAllMocks());

  test('returns no predictions for a too-short input, without calling Google', async () => {
    global.fetch = jest.fn();
    const app = makeApp(geocodeRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).get('/api/x/autocomplete').query({ input: 'wi' });
    expect(res.status).toBe(200);
    expect(res.body.predictions).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns predictions on a successful lookup', async () => {
    mockFetchOnce({
      suggestions: [{ placePrediction: { placeId: 'abc123', text: { text: 'Winfomi - Salesforce Partner, Coimbatore' } } }],
    });
    const app = makeApp(geocodeRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).get('/api/x/autocomplete').query({ input: 'winf' });
    expect(res.status).toBe(200);
    expect(res.body.predictions[0].place_id).toBe('abc123');
  });

  test('502 when the upstream API call fails', async () => {
    global.fetch = jest.fn().mockRejectedValueOnce(new Error('network down'));
    const app = makeApp(geocodeRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).get('/api/x/autocomplete').query({ input: 'winf' });
    expect(res.status).toBe(502);
  });
});

describe('GET /api/x/place-details', () => {
  afterEach(() => jest.restoreAllMocks());

  test('400 when place_id missing', async () => {
    const app = makeApp(geocodeRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).get('/api/x/place-details');
    expect(res.status).toBe(400);
  });

  test('returns lat/lng and formatted address on success', async () => {
    mockFetchOnce({
      location: { latitude: 11.01, longitude: 76.95 },
      formattedAddress: 'Winfomi, Coimbatore, TN',
    });
    const app = makeApp(geocodeRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).get('/api/x/place-details').query({ place_id: 'abc123' });
    expect(res.status).toBe(200);
    expect(res.body.latitude).toBe(11.01);
    expect(res.body.display_name).toBe('Winfomi, Coimbatore, TN');
  });

  test('502 when the place has no location', async () => {
    // Distinct place_id from the previous test — place-details caches
    // successful lookups by place_id, and reusing one would return the
    // earlier test's cached result instead of hitting this mock.
    mockFetchOnce({});
    const app = makeApp(geocodeRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).get('/api/x/place-details').query({ place_id: 'no-location-xyz' });
    expect(res.status).toBe(502);
  });
});

describe('GET /api/x/reverse', () => {
  afterEach(() => jest.restoreAllMocks());

  test('400 when lat/lng missing', async () => {
    const app = makeApp(geocodeRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).get('/api/x/reverse');
    expect(res.status).toBe(400);
  });

  test('falls back to coordinates on upstream failure', async () => {
    global.fetch = jest.fn().mockRejectedValueOnce(new Error('down'));
    const app = makeApp(geocodeRouter, { basePath: '/api/x', employee: REP });
    const res = await request(app).get('/api/x/reverse').query({ lat: 11.0168, lng: 76.9558 });
    expect(res.status).toBe(502);
    expect(res.body.address).toBe('11.01680, 76.95580');
  });
});
