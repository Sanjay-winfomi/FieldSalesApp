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
