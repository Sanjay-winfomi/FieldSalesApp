"""
google_routes.py — ports googleRoutesService.js exactly, same endpoint,
request body fields, headers, timeout, and bounded retry policy. Never falls
back to haversine on failure (see INVENTORY.md §8.5) — callers propagate a
502 route_computation_failed instead, matching visits.routes.js /
attendance.routes.js.
"""
import asyncio
from dataclasses import dataclass
from typing import Optional

import httpx

from app.core.config import GOOGLE_MAPS_API_KEY

ROUTES_API_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
UPSTREAM_TIMEOUT_SECONDS = 8.0
MAX_ATTEMPTS = 2
RETRY_DELAY_SECONDS = 0.5

FIELD_MASK = ",".join([
    "routes.duration",
    "routes.staticDuration",
    "routes.distanceMeters",
    "routes.polyline.encodedPolyline",
    "routes.travelAdvisory",
])


class RoutesApiError(Exception):
    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


@dataclass
class RouteResult:
    distance_meters: Optional[int]
    duration_seconds: Optional[int]
    duration_in_traffic_seconds: Optional[int]
    static_duration_seconds: Optional[int]
    encoded_polyline: Optional[str]


def _parse_google_duration(value) -> Optional[int]:
    if not isinstance(value, str):
        return None
    try:
        return int(value.rstrip("s"))
    except ValueError:
        return None


async def _compute_route_once(origin_lat: float, origin_lng: float, dest_lat: float, dest_lng: float) -> RouteResult:
    if not GOOGLE_MAPS_API_KEY:
        raise RoutesApiError("GOOGLE_MAPS_API_KEY is not configured", retryable=False)

    body = {
        "origin": {"location": {"latLng": {"latitude": origin_lat, "longitude": origin_lng}}},
        "destination": {"location": {"latLng": {"latitude": dest_lat, "longitude": dest_lng}}},
        "travelMode": "DRIVE",
        "routingPreference": "TRAFFIC_AWARE",
        "computeAlternativeRoutes": False,
        "units": "METRIC",
        "languageCode": "en-US",
    }
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": FIELD_MASK,
    }

    try:
        async with httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_SECONDS) as client:
            response = await client.post(ROUTES_API_URL, json=body, headers=headers)
    except httpx.TransportError as err:
        raise RoutesApiError(f"Routes API request failed: {err}", retryable=True) from err
    except httpx.TimeoutException as err:
        raise RoutesApiError(f"Routes API request failed: {err}", retryable=True) from err

    try:
        data = response.json()
    except ValueError:
        data = {}

    if response.status_code >= 400:
        message = (data.get("error") or {}).get("message", "no details")
        retryable = response.status_code == 429 or response.status_code >= 500
        raise RoutesApiError(f"Routes API error {response.status_code}: {message}", retryable=retryable)

    routes = data.get("routes") or []
    if not routes:
        raise RoutesApiError("Routes API returned no route for this origin/destination", retryable=False)

    route = routes[0]
    static_duration = _parse_google_duration(route.get("staticDuration"))
    live_duration = _parse_google_duration(route.get("duration"))

    return RouteResult(
        distance_meters=route.get("distanceMeters"),
        duration_seconds=static_duration,
        duration_in_traffic_seconds=live_duration,
        static_duration_seconds=static_duration,
        encoded_polyline=(route.get("polyline") or {}).get("encodedPolyline"),
    )


async def compute_route(origin_lat: float, origin_lng: float, dest_lat: float, dest_lng: float) -> RouteResult:
    last_error: Optional[RoutesApiError] = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return await _compute_route_once(origin_lat, origin_lng, dest_lat, dest_lng)
        except RoutesApiError as err:
            last_error = err
            if attempt < MAX_ATTEMPTS and err.retryable:
                await asyncio.sleep(RETRY_DELAY_SECONDS)
                continue
            raise
    raise last_error  # pragma: no cover — unreachable, satisfies type checkers
