"""
duration.py — parses the small subset of jsonwebtoken/ms-style duration
strings this app actually uses for JWT_EXPIRES_IN / JWT_REFRESH_EXPIRES_IN
('8h', '7d') into seconds. Falls back to treating a bare numeric string as
seconds (ms' own behavior) if a future env value ever uses one.
"""
import re

_UNIT_SECONDS = {
    "s": 1,
    "m": 60,
    "h": 60 * 60,
    "d": 60 * 60 * 24,
}

_PATTERN = re.compile(r"^(\d+)\s*([smhd])$")


def parse_duration_seconds(value: str) -> int:
    match = _PATTERN.match(value.strip())
    if match:
        amount, unit = match.groups()
        return int(amount) * _UNIT_SECONDS[unit]
    return int(value)
