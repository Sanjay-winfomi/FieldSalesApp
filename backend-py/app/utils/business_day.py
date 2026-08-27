"""
business_day.py — ports businessDay.js exactly. The field-sales "day" rolls
over at DAY_BOUNDARY_HOUR (default 5am IST), not calendar midnight.
DAY_BOUNDARY_HOUR is read once at startup (app.core.config) — restart to
pick up a changed value, matching the Node behavior.
"""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from app.core.config import DAY_BOUNDARY_HOUR

IST = ZoneInfo("Asia/Kolkata")


def business_date_expr(timestamp_expr: str) -> str:
    """SQL fragment: the business date for a timestamptz SQL expression."""
    return f"DATE(({timestamp_expr}) AT TIME ZONE 'Asia/Kolkata' - INTERVAL '{DAY_BOUNDARY_HOUR} hours')"


def is_current_business_day(timestamp_expr: str) -> str:
    """SQL condition: is `timestamp_expr` within the current business day?"""
    return f"{business_date_expr(timestamp_expr)} = {business_date_expr('NOW()')}"


def get_business_date_string(now: datetime | None = None) -> str:
    """Python-side equivalent of business_date_expr('NOW()') — today's
    business date as 'YYYY-MM-DD', for routes validating a caller-supplied
    date against "today" without a DB round trip."""
    if now is None:
        now = datetime.now(tz=timezone.utc)
    elif now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    shifted = now - timedelta(hours=DAY_BOUNDARY_HOUR)
    shifted_ist = shifted.astimezone(IST)
    return shifted_ist.strftime("%Y-%m-%d")
