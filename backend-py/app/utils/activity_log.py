"""activity_log.py — ports activityLog.js exactly (structured info/warn
logs for the four core login/logout flows)."""
from app.core.logging_config import log_info, log_warn


def log_day_login(username: str, lat, lng) -> None:
    log_info("day_login", username=username, lat=lat, lng=lng)


def log_day_logout(username: str, duration_mins: int, distance_km) -> None:
    log_info("day_logout", username=username, durationMins=duration_mins, distanceKm=float(distance_km or 0))


def log_dealer_login(username: str, dealer_name: str) -> None:
    log_info("dealer_login", username=username, dealerName=dealer_name)


def log_dealer_logout(username: str, dealer_name: str, duration_mins: int, out_of_radius: bool) -> None:
    log_info("dealer_logout", username=username, dealerName=dealer_name, durationMins=duration_mins, outOfRadius=bool(out_of_radius))


def log_visit_interrupted(username: str, dealer_name: str, distance_meters) -> None:
    log_warn("visit_interrupted", username=username, dealerName=dealer_name, distanceMeters=distance_meters)
