"""
json_shape.py — response-shape parity helpers.

Node's `pg` driver serializes TIMESTAMPTZ columns as JS `Date` objects, which
`res.json()` turns into ISO-8601 strings with millisecond precision and a
literal 'Z' suffix (e.g. "2026-08-27T10:15:30.123Z") via `Date.prototype.
toJSON`. Python's `datetime.isoformat()` instead produces microsecond
precision with a numeric UTC offset ("...+00:00"), which is a different wire
format even though both are valid ISO-8601 — mobile/web clients that do exact
string comparisons or regex-parse the suffix would break. `iso_z()` and
`serialize_row()` below normalize every route's output to match Node's exact
format.

DATE columns (business_date, reminder_date, ...) are returned by asyncpg as
plain `datetime.date` — same as the raw 'YYYY-MM-DD' string pool.js's custom
type parser produces, so `.isoformat()` on those needs no adjustment (see
app/db/pool.py's module docstring).
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Any


def iso_z(value: datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=None)
        iso = value.isoformat(timespec="milliseconds")
        return iso + "Z"
    utc = value.astimezone(tz=None) if False else value
    iso = utc.isoformat(timespec="milliseconds")
    # Replace a numeric UTC offset (+00:00) with 'Z', matching Date#toJSON().
    if iso.endswith("+00:00"):
        return iso[:-6] + "Z"
    return iso


def serialize_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return iso_z(value)
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, dict):
        return {k: serialize_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [serialize_value(v) for v in value]
    return value


def serialize_row(record) -> dict:
    if record is None:
        return None
    return {k: serialize_value(v) for k, v in dict(record).items()}


def serialize_rows(records) -> list:
    return [serialize_row(r) for r in records]
