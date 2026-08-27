"""Ported from backend/tests/routes/geocode.routes.test.js — same test intent,
same assertions, adapted to replace geocode.py's own `httpx` binding with a
fake AsyncClient (the seam `_google_fetch`/`_places_api_fetch` call through)
in place of Jest's `global.fetch = jest.fn().mockResolvedValueOnce(...)` /
`mockRejectedValueOnce(...)` mocking of the Node route's raw `fetch`.

Patching httpx.AsyncClient itself (globally) doesn't work here: the test
client (tests/helpers/test_app.py's `make_client`) is ALSO an httpx.AsyncClient
under the hood, so a global patch breaks every request the test makes, not
just geocode.py's outbound calls. Instead we swap the `httpx` name inside
geocode_module's own namespace for a fake — `import httpx` binds that name
per-module, so this leaves the real httpx (and the test client) untouched."""
import types

import pytest

from app.routers import geocode as geocode_module
from tests.helpers.test_app import make_client


@pytest.fixture
def client():
    return make_client(geocode_module.router, prefix="/api/x")


class FakeHttpxResponse:
    """Stand-in for an httpx.Response — only the surface _google_fetch/
    _places_api_fetch actually touch (.status_code, .json())."""

    def __init__(self, status_code: int, json_data):
        self.status_code = status_code
        self._json_data = json_data

    def json(self):
        return self._json_data


class _FakeAsyncClient:
    """Stand-in for httpx.AsyncClient, installed only into geocode_module's
    `httpx` binding. Configured per-test via its class attributes (reset by
    the autouse `_setup` fixture below) since geocode.py instantiates a new
    `httpx.AsyncClient(...)` on every call."""

    get_response = None
    get_error = None
    request_response = None
    request_error = None
    get_calls = 0
    request_calls = 0

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def get(self, url):
        _FakeAsyncClient.get_calls += 1
        if _FakeAsyncClient.get_error is not None:
            raise _FakeAsyncClient.get_error
        return _FakeAsyncClient.get_response

    async def request(self, method, url, headers=None, json=None):
        _FakeAsyncClient.request_calls += 1
        if _FakeAsyncClient.request_error is not None:
            raise _FakeAsyncClient.request_error
        return _FakeAsyncClient.request_response


@pytest.fixture(autouse=True)
def _setup(monkeypatch):
    # geocode.py imports GOOGLE_MAPS_API_KEY *by value* at module load time
    # (`from app.core.config import GOOGLE_MAPS_API_KEY`), so patching
    # app.core.config's copy wouldn't affect geocode.py's own module-level
    # name — patch geocode_module's binding directly. Mirrors the Node test
    # file's `process.env.GOOGLE_MAPS_API_KEY = 'test-key'` (set once, before
    # geocode.routes.js is required, so the Node module sees a real key too).
    monkeypatch.setattr(geocode_module, "GOOGLE_MAPS_API_KEY", "test-key")
    # geocode.py's in-memory cache is a plain module-level dict that persists
    # across tests within the same process (same as the Node route's
    # module-level `cache` Map persisting across tests in one Jest file) —
    # clear it so one test's cached response can't leak into another via a
    # repeated query string/place_id/lat-lng pair.
    geocode_module._cache.clear()
    monkeypatch.setattr(geocode_module, "httpx", types.SimpleNamespace(AsyncClient=_FakeAsyncClient))
    _FakeAsyncClient.get_response = None
    _FakeAsyncClient.get_error = None
    _FakeAsyncClient.request_response = None
    _FakeAsyncClient.request_error = None
    _FakeAsyncClient.get_calls = 0
    _FakeAsyncClient.request_calls = 0
    yield


def mock_get_once(monkeypatch, status_code, json_data):
    """Configures the fake httpx.AsyncClient.get() call _google_fetch makes
    (the legacy Geocoding API — GET with a `key` query param)."""
    _FakeAsyncClient.get_response = FakeHttpxResponse(status_code, json_data)


def mock_get_error(monkeypatch, exc):
    _FakeAsyncClient.get_error = exc


def mock_request_once(monkeypatch, status_code, json_data):
    """Configures the fake httpx.AsyncClient.request() call
    _places_api_fetch makes (Places API (New) — POST/GET with an
    X-Goog-Api-Key header)."""
    _FakeAsyncClient.request_response = FakeHttpxResponse(status_code, json_data)


def mock_request_error(monkeypatch, exc):
    _FakeAsyncClient.request_error = exc


def assert_request_not_called():
    """Mirrors Jest's `expect(global.fetch).not.toHaveBeenCalled()`."""
    assert _FakeAsyncClient.request_calls == 0


class TestSearch:
    async def test_400_when_q_missing(self, client):
        async with client as c:
            res = await c.get("/api/x/search")
        assert res.status_code == 400

    async def test_returns_candidates_on_a_successful_lookup(self, client, monkeypatch):
        mock_get_once(monkeypatch, 200, {
            "status": "OK",
            "results": [{
                "geometry": {"location": {"lat": 11.01, "lng": 76.95}},
                "formatted_address": "Coimbatore, TN",
            }],
        })
        async with client as c:
            res = await c.get("/api/x/search", params={"q": "Coimbatore"})
        assert res.status_code == 200
        body = res.json()
        assert body["found"] is True
        assert body["candidates"][0]["display_name"] == "Coimbatore, TN"

    async def test_502_when_the_upstream_api_call_fails(self, client, monkeypatch):
        mock_get_error(monkeypatch, Exception("network down"))
        async with client as c:
            res = await c.get("/api/x/search", params={"q": "Nowhere"})
        assert res.status_code == 502


class TestAutocomplete:
    async def test_returns_no_predictions_for_a_too_short_input_without_calling_google(self, client, monkeypatch):
        async with client as c:
            res = await c.get("/api/x/autocomplete", params={"input": "wi"})
        assert res.status_code == 200
        assert res.json()["predictions"] == []
        assert_request_not_called()

    async def test_returns_predictions_on_a_successful_lookup(self, client, monkeypatch):
        mock_request_once(monkeypatch, 200, {
            "suggestions": [{
                "placePrediction": {
                    "placeId": "abc123",
                    "text": {"text": "Winfomi - Salesforce Partner, Coimbatore"},
                },
            }],
        })
        async with client as c:
            res = await c.get("/api/x/autocomplete", params={"input": "winf"})
        assert res.status_code == 200
        assert res.json()["predictions"][0]["place_id"] == "abc123"

    async def test_502_when_the_upstream_api_call_fails(self, client, monkeypatch):
        mock_request_error(monkeypatch, Exception("network down"))
        async with client as c:
            res = await c.get("/api/x/autocomplete", params={"input": "winf"})
        assert res.status_code == 502


class TestPlaceDetails:
    async def test_400_when_place_id_missing(self, client):
        async with client as c:
            res = await c.get("/api/x/place-details")
        assert res.status_code == 400

    async def test_returns_lat_lng_and_formatted_address_on_success(self, client, monkeypatch):
        mock_request_once(monkeypatch, 200, {
            "location": {"latitude": 11.01, "longitude": 76.95},
            "formattedAddress": "Winfomi, Coimbatore, TN",
        })
        async with client as c:
            res = await c.get("/api/x/place-details", params={"place_id": "abc123"})
        assert res.status_code == 200
        body = res.json()
        assert body["latitude"] == 11.01
        assert body["display_name"] == "Winfomi, Coimbatore, TN"

    async def test_502_when_the_place_has_no_location(self, client, monkeypatch):
        # Distinct place_id from the previous test — place-details caches
        # successful lookups by place_id, and reusing one would return the
        # earlier test's cached result instead of hitting this mock.
        mock_request_once(monkeypatch, 200, {})
        async with client as c:
            res = await c.get("/api/x/place-details", params={"place_id": "no-location-xyz"})
        assert res.status_code == 502


class TestReverse:
    # Was xfail: geocode.py originally declared lat/lng as FastAPI-required
    # Query(...) params, so a missing value hit FastAPI's own 422 validation
    # error before the route's custom NaN-check/400 path ever ran. Fixed by
    # making lat/lng optional Query params (default None) so "missing" and
    # "present but non-numeric" both funnel through the same custom
    # validation, matching geocode.routes.js's parseFloat(undefined) -> NaN
    # -> 400 behavior. Now passes for real, not xfail.
    async def test_400_when_lat_lng_missing(self, client):
        async with client as c:
            res = await c.get("/api/x/reverse")
        assert res.status_code == 400

    async def test_falls_back_to_coordinates_on_upstream_failure(self, client, monkeypatch):
        mock_get_error(monkeypatch, Exception("down"))
        async with client as c:
            res = await c.get("/api/x/reverse", params={"lat": 11.0168, "lng": 76.9558})
        assert res.status_code == 502
        assert res.json()["address"] == "11.01680, 76.95580"
