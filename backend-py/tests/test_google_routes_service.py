"""Ported from backend/tests/services/googleRoutesService.test.js — same
test intent, same assertions, adapted from Jest's `global.fetch` mock to
monkeypatching `httpx.AsyncClient.post` (the actual call site in
app/services/google_routes.py's `_compute_route_once`).

Jest's version relies on real (500ms) setTimeout delays for the one retry
path it exercises ('retries once on a 503...') — it does not use fake
timers, so that test genuinely waits out the delay. The Python port instead
monkeypatches RETRY_DELAY_SECONDS down to a small value for that one test,
for pytest speed, without changing the retry behavior being tested (still a
real await asyncio.sleep(...) call, just a short one)."""
import httpx
import pytest

from app.services import google_routes
from app.services.google_routes import RoutesApiError, compute_route

ROUTE_ARGS = {"origin_lat": 12.9, "origin_lng": 77.6, "dest_lat": 13.0, "dest_lng": 77.7}


class FakePostQueue:
    """Queues httpx.Response objects or exceptions, consumed in order by
    successive calls, and records each call's (url, kwargs) — mirrors
    Jest's `global.fetch.mockResolvedValueOnce(...)` chaining plus
    `global.fetch.mock.calls`."""

    def __init__(self):
        self._queue = []
        self.calls = []

    def queue(self, value):
        self._queue.append(value)

    async def __call__(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if not self._queue:
            raise AssertionError("FakePostQueue called with no queued result")
        value = self._queue.pop(0)
        if isinstance(value, BaseException):
            raise value
        return value


@pytest.fixture
def fake_post(monkeypatch):
    fake = FakePostQueue()
    monkeypatch.setattr(httpx.AsyncClient, "post", fake)
    monkeypatch.setattr(google_routes, "GOOGLE_MAPS_API_KEY", "test-key")
    return fake


class TestComputeRoute:
    async def test_parses_a_successful_response_into_distance_duration_polyline(self, fake_post):
        fake_post.queue(
            httpx.Response(
                200,
                json={
                    "routes": [
                        {
                            "distanceMeters": 5200,
                            "duration": "620s",
                            "staticDuration": "580s",
                            "polyline": {"encodedPolyline": "abc123"},
                        }
                    ]
                },
            )
        )

        result = await compute_route(**ROUTE_ARGS)

        assert result.distance_meters == 5200
        assert result.duration_seconds == 580
        assert result.duration_in_traffic_seconds == 620
        assert result.static_duration_seconds == 580
        assert result.encoded_polyline == "abc123"
        assert len(fake_post.calls) == 1
        url, kwargs = fake_post.calls[0]
        assert "computeRoutes" in url
        assert kwargs["headers"]["X-Goog-Api-Key"] == "test-key"
        assert kwargs["json"]["computeAlternativeRoutes"] is False

    async def test_does_not_retry_a_genuine_4xx_eg_bad_request(self, fake_post):
        fake_post.queue(httpx.Response(400, json={"error": {"message": "invalid argument"}}))

        with pytest.raises(RoutesApiError, match="Routes API error 400"):
            await compute_route(**ROUTE_ARGS)
        assert len(fake_post.calls) == 1

    async def test_retries_once_on_a_503_and_succeeds_on_the_second_attempt(self, fake_post, monkeypatch):
        # Real retry-with-sleep path (unlike Jest, no fake timers) — shorten
        # the delay so this test doesn't genuinely wait 500ms.
        monkeypatch.setattr(google_routes, "RETRY_DELAY_SECONDS", 0.01)
        fake_post.queue(httpx.Response(503, json={}))
        fake_post.queue(
            httpx.Response(200, json={"routes": [{"distanceMeters": 100, "duration": "60s", "polyline": {}}]})
        )

        result = await compute_route(**ROUTE_ARGS)

        assert result.distance_meters == 100
        assert len(fake_post.calls) == 2

    async def test_throws_when_google_maps_api_key_is_not_configured(self, fake_post, monkeypatch):
        monkeypatch.setattr(google_routes, "GOOGLE_MAPS_API_KEY", "")

        with pytest.raises(RoutesApiError, match="GOOGLE_MAPS_API_KEY"):
            await compute_route(**ROUTE_ARGS)
        assert len(fake_post.calls) == 0

    async def test_throws_a_non_retryable_error_when_google_returns_no_route(self, fake_post):
        fake_post.queue(httpx.Response(200, json={"routes": []}))

        with pytest.raises(RoutesApiError, match="no route"):
            await compute_route(**ROUTE_ARGS)
        assert len(fake_post.calls) == 1
