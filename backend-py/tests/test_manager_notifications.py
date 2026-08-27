"""Ported from backend/tests/utils/managerNotifications.test.js — same test
intent, same assertions, adapted to FakePool's queue-based mocking (see
tests/helpers/fake_pool.py) in place of Jest's `pool.query.mockResolvedValueOnce`."""
import pytest

from app.services.manager_notifications import create_manager_notification


class TestCreateManagerNotification:
    async def test_inserts_business_date_and_guards_it_with_on_conflict_do_nothing_for_day_absent(self, mock_pool):
        mock_pool.queue_execute({})

        await create_manager_notification(
            type="day_absent",
            title="Representative did not log in",
            body="divya did not log in on 18 Aug 2026",
            severity="danger",
            employee_id=4,
            business_date="2026-08-18",
        )

        call = mock_pool.execute_calls[0]
        assert "business_date" in call.query
        assert "ON CONFLICT (employee_id, business_date) WHERE type = 'day_absent' DO NOTHING" in call.query
        assert call.args == (
            "day_absent",
            "Representative did not log in",
            "divya did not log in on 18 Aug 2026",
            "danger",
            4,
            None,
            None,
            None,
            "2026-08-18",
        )

    async def test_leaves_business_date_null_for_notification_types_with_no_business_date_concept(self, mock_pool):
        mock_pool.queue_execute({})

        await create_manager_notification(
            type="left_dealer",
            title="Left dealer",
            body="rep left the dealer premises",
            employee_id=4,
            dealer_id=9,
        )

        call = mock_pool.execute_calls[0]
        assert call.args[-1] is None

    async def test_swallows_a_db_error_instead_of_throwing(self, mock_pool):
        mock_pool.queue_execute(Exception("db down"))

        await create_manager_notification(type="day_absent", title="t", body="b")
