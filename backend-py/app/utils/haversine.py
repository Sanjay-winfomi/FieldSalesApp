"""
haversine.py — ports haversine.js exactly. Great-circle distance in
kilometres. NOTE (see INVENTORY.md §8.5): only used for radius/geofence
checks (login/logout/location-check distance-to-dealer) — NOT for any
distance-travelled totals, which go through Google Routes API with no
fallback (see app/services/google_routes.py).
"""
import math

EARTH_RADIUS_KM = 6371


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    to_rad = math.radians
    d_lat = to_rad(lat2 - lat1)
    d_lng = to_rad(lng2 - lng1)

    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(to_rad(lat1)) * math.cos(to_rad(lat2)) * math.sin(d_lng / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return EARTH_RADIUS_KM * c


def is_within_radius(lat1: float, lng1: float, lat2: float, lng2: float, radius_meters: float) -> bool:
    return haversine_km(lat1, lng1, lat2, lng2) * 1000 <= radius_meters
