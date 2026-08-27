"""geocode.py — ports geocode.routes.js exactly (5 routes, in-memory cache,
Google Geocoding + Places API (New) proxying). Any authenticated employee."""
import time
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, Query
from starlette.responses import JSONResponse

from app.core.config import GOOGLE_MAPS_API_KEY
from app.core.logging_config import log_error
from app.core.security import Employee, get_current_employee

router = APIRouter(dependencies=[Depends(get_current_employee)])

GOOGLE_GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"
PLACES_API_BASE = "https://places.googleapis.com/v1"

CACHE_TTL_SECONDS = 10 * 60
_cache: dict[str, tuple[float, dict]] = {}

UPSTREAM_TIMEOUT_SECONDS = 8.0


def _get_cached(key: str):
    entry = _cache.get(key)
    if not entry:
        return None
    stored_at, value = entry
    if time.monotonic() - stored_at > CACHE_TTL_SECONDS:
        del _cache[key]
        return None
    return value


def _set_cached(key: str, value: dict) -> None:
    _cache[key] = (time.monotonic(), value)


class GoogleApiError(Exception):
    pass


async def _google_fetch(base_url: str, params: dict) -> dict:
    if not GOOGLE_MAPS_API_KEY:
        raise GoogleApiError("GOOGLE_MAPS_API_KEY is not configured")
    query = urlencode({**params, "key": GOOGLE_MAPS_API_KEY})
    async with httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_SECONDS) as client:
        response = await client.get(f"{base_url}?{query}")
    if response.status_code >= 400:
        raise GoogleApiError(f"Google Maps API responded {response.status_code}")
    data = response.json()
    if data.get("status") not in ("OK", "ZERO_RESULTS"):
        raise GoogleApiError(f"Google Maps API status {data.get('status')}: {data.get('error_message', 'no details')}")
    return data


async def _places_api_fetch(path: str, method: str = "GET", body: dict | None = None, field_mask: str | None = None) -> dict:
    if not GOOGLE_MAPS_API_KEY:
        raise GoogleApiError("GOOGLE_MAPS_API_KEY is not configured")
    headers = {"X-Goog-Api-Key": GOOGLE_MAPS_API_KEY}
    if field_mask:
        headers["X-Goog-FieldMask"] = field_mask
    if body is not None:
        headers["Content-Type"] = "application/json"

    async with httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_SECONDS) as client:
        response = await client.request(method, f"{PLACES_API_BASE}{path}", headers=headers, json=body)
    data = response.json()
    if response.status_code >= 400:
        message = (data.get("error") or {}).get("message", "no details")
        raise GoogleApiError(f"Places API error {response.status_code}: {message}")
    return data


@router.get("/search")
async def search(q: str = Query(default="")):
    q = q.strip()
    if not q:
        return JSONResponse({"error": "q (address) is required"}, status_code=400)

    cache_key = f"search:{q.lower()}"
    cached = _get_cached(cache_key)
    if cached is not None:
        return cached

    try:
        data = await _google_fetch(GOOGLE_GEOCODE_URL, {"address": q})
        results = data.get("results") or []
        if not results:
            empty = {"found": False, "candidates": []}
            _set_cached(cache_key, empty)
            return empty

        candidates = [
            {
                "latitude": r["geometry"]["location"]["lat"],
                "longitude": r["geometry"]["location"]["lng"],
                "display_name": r["formatted_address"],
            }
            for r in results[:5]
        ]
        result = {"found": True, "candidates": candidates}
        _set_cached(cache_key, result)
        return result
    except Exception as err:  # noqa: BLE001
        log_error("Geocode search error", error=str(err))
        return JSONResponse(
            {"error": "Geocoding service unavailable — you can still enter coordinates manually."},
            status_code=502,
        )


def _extract_raw_address(components: list[dict]) -> dict:
    def by_type(t: str):
        for c in components:
            if t in c.get("types", []):
                return c.get("long_name")
        return None

    return {
        "house_number": by_type("street_number"),
        "road": by_type("route"),
        "suburb": by_type("sublocality") or by_type("sublocality_level_1"),
        "neighbourhood": by_type("neighborhood"),
        "city_district": by_type("administrative_area_level_2"),
        "city": by_type("locality"),
        "town": None,
        "village": None,
        "state": by_type("administrative_area_level_1"),
        "postcode": by_type("postal_code"),
        "country": by_type("country"),
    }


@router.get("/reverse")
async def reverse(lat: str | None = Query(default=None), lng: str | None = Query(default=None)):
    # lat/lng are optional Query params (not FastAPI-required) on purpose:
    # Node's route treats a missing value the same as a non-numeric one
    # (parseFloat(undefined) -> NaN -> the route's own 400 JSON body).
    # Declaring them as FastAPI-required instead would make FastAPI's own
    # request validation reject a missing value with a different, generic
    # 422 body before this handler ever runs — a real contract break.
    try:
        lat_f = float(lat)
        lng_f = float(lng)
    except (TypeError, ValueError):
        lat_f = lng_f = float("nan")

    if not (lat_f == lat_f) or not (-90 <= lat_f <= 90) or not (lng_f == lng_f) or not (-180 <= lng_f <= 180):
        return JSONResponse({"error": "lat and lng must be valid numbers (-90..90, -180..180)"}, status_code=400)

    cache_key = f"reverse:{lat_f:.4f},{lng_f:.4f}"
    cached = _get_cached(cache_key)
    if cached is not None:
        return cached

    try:
        data = await _google_fetch(GOOGLE_GEOCODE_URL, {"latlng": f"{lat_f},{lng_f}"})
        results = data.get("results") or []
        top = results[0] if results else None

        address = (top or {}).get("formatted_address") or f"{lat_f:.5f}, {lng_f:.5f}"
        raw = _extract_raw_address(top["address_components"]) if top and top.get("address_components") else None
        payload = {"address": address, "raw": raw}
        _set_cached(cache_key, payload)
        return payload
    except Exception as err:  # noqa: BLE001
        log_error("Geocode reverse error", error=str(err))
        return JSONResponse(
            {"error": "Geocoding service unavailable", "address": f"{lat_f:.5f}, {lng_f:.5f}"},
            status_code=502,
        )


@router.get("/nearby")
async def nearby(lat: str | None = Query(default=None), lng: str | None = Query(default=None), radius: str = Query(default="150")):
    # See /reverse's comment above — lat/lng optional here for the same reason.
    try:
        lat_f = float(lat)
        lng_f = float(lng)
    except (TypeError, ValueError):
        lat_f = lng_f = float("nan")

    try:
        radius_i = int(radius)
    except (TypeError, ValueError):
        radius_i = 150
    radius_i = min(max(radius_i or 150, 1), 500)

    if not (lat_f == lat_f) or not (-90 <= lat_f <= 90) or not (lng_f == lng_f) or not (-180 <= lng_f <= 180):
        return JSONResponse({"error": "lat and lng must be valid numbers (-90..90, -180..180)"}, status_code=400)

    cache_key = f"nearby:{lat_f:.4f},{lng_f:.4f},{radius_i}"
    cached = _get_cached(cache_key)
    if cached is not None:
        return cached

    try:
        data = await _places_api_fetch(
            "/places:searchNearby",
            method="POST",
            field_mask="places.displayName,places.location,places.types",
            body={
                "maxResultCount": 20,
                "locationRestriction": {"circle": {"center": {"latitude": lat_f, "longitude": lng_f}, "radius": radius_i}},
            },
        )
        places = []
        for p in data.get("places") or []:
            name = (p.get("displayName") or {}).get("text")
            location = p.get("location") or {}
            latitude = location.get("latitude")
            longitude = location.get("longitude")
            if name and latitude is not None and longitude is not None:
                places.append({
                    "name": name,
                    "latitude": latitude,
                    "longitude": longitude,
                    "type": (p.get("types") or ["place"])[0],
                })
        places = places[:30]
        result = {"places": places}
        _set_cached(cache_key, result)
        return result
    except Exception as err:  # noqa: BLE001
        log_error("Geocode nearby error", error=str(err))
        return JSONResponse({"error": "Nearby-places lookup unavailable", "places": []}, status_code=502)


@router.get("/autocomplete")
async def autocomplete(input: str = Query(default=""), sessiontoken: str | None = Query(default=None)):
    input = input.strip()
    if len(input) < 3:
        return {"predictions": []}

    try:
        body = {"input": input, "includedRegionCodes": ["in"]}
        if sessiontoken:
            body["sessionToken"] = sessiontoken

        data = await _places_api_fetch("/places:autocomplete", method="POST", body=body)
        predictions = [
            {
                "place_id": s["placePrediction"]["placeId"],
                "description": (s["placePrediction"].get("text") or {}).get("text", ""),
            }
            for s in (data.get("suggestions") or [])
            if s.get("placePrediction")
        ][:6]
        return {"predictions": predictions}
    except Exception as err:  # noqa: BLE001
        log_error("Geocode autocomplete error", error=str(err))
        return JSONResponse({"error": "Autocomplete unavailable", "predictions": []}, status_code=502)


@router.get("/place-details")
async def place_details(place_id: str = Query(default="", alias="place_id"), sessiontoken: str | None = Query(default=None)):
    place_id = place_id.strip()
    if not place_id:
        return JSONResponse({"error": "place_id is required"}, status_code=400)

    cache_key = f"place-details:{place_id}"
    cached = _get_cached(cache_key)
    if cached is not None:
        return cached

    try:
        qs = f"?sessionToken={sessiontoken}" if sessiontoken else ""
        data = await _places_api_fetch(f"/places/{place_id}{qs}", field_mask="location,formattedAddress")
        if not data.get("location"):
            return JSONResponse({"error": "No location found for that place"}, status_code=502)

        payload = {
            "latitude": data["location"]["latitude"],
            "longitude": data["location"]["longitude"],
            "display_name": data.get("formattedAddress"),
        }
        _set_cached(cache_key, payload)
        return payload
    except Exception as err:  # noqa: BLE001
        log_error("Geocode place-details error", error=str(err))
        return JSONResponse({"error": "Place lookup unavailable"}, status_code=502)
