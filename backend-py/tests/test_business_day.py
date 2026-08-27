"""Ported from backend/tests/utils/businessDay.test.js — same intent, same
IST-boundary edge cases."""
from datetime import datetime, timezone

from app.utils.business_day import (
    DAY_BOUNDARY_HOUR,
    business_date_expr,
    get_business_date_string,
    is_current_business_day,
)


class TestBusinessDay:
    def test_day_boundary_hour_defaults_to_5(self):
        assert DAY_BOUNDARY_HOUR == 5

    def test_business_date_expr_shifts_back_by_boundary_hour(self):
        expr = business_date_expr("some_column")
        assert expr == "DATE((some_column) AT TIME ZONE 'Asia/Kolkata' - INTERVAL '5 hours')"

    def test_is_current_business_day_compares_both_sides_using_same_expr(self):
        cond = is_current_business_day("login_time")
        assert "login_time" in cond
        assert "NOW()" in cond
        assert len(cond.split("=")) == 2


class TestGetBusinessDateString:
    def test_daytime_bucket_matches_plain_ist_calendar_date(self):
        # 2026-08-10 10:00 UTC = 2026-08-10 15:30 IST — well past the 5am
        # boundary, and no UTC/IST calendar-date crossing involved either.
        now = datetime(2026, 8, 10, 10, 0, 0, tzinfo=timezone.utc)
        assert get_business_date_string(now) == "2026-08-10"

    def test_just_after_ist_midnight_but_before_boundary_still_previous_day(self):
        # 2026-08-10 19:00 UTC = 2026-08-11 00:30 IST — past IST midnight, but
        # before the 5am boundary, so business date is still Aug 10.
        now = datetime(2026, 8, 10, 19, 0, 0, tzinfo=timezone.utc)
        assert get_business_date_string(now) == "2026-08-10"

    def test_rolls_over_at_5am_ist_even_though_utc_date_has_not(self):
        # 2026-08-10 23:45 UTC = 2026-08-11 05:15 IST — past the boundary, so
        # the business day has already rolled to Aug 11, even though the UTC
        # calendar date (what a naive date-only slice would give) is still
        # Aug 10. This is exactly the drift get_business_date_string exists
        # to avoid.
        now = datetime(2026, 8, 10, 23, 45, 0, tzinfo=timezone.utc)
        assert get_business_date_string(now) == "2026-08-11"
        assert now.date().isoformat() == "2026-08-10"  # the drift, for contrast

    def test_defaults_to_current_time_when_no_argument_given(self):
        import re

        assert re.match(r"^\d{4}-\d{2}-\d{2}$", get_business_date_string())
