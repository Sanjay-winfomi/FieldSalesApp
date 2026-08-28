"""Ported from backend/tests/utils/absenceCheck.test.js — same test intent,
same assertions, adapted to FakePool's queue-based mocking (see
tests/helpers/fake_pool.py) in place of Jest's `pool.query.mockResolvedValueOnce`,
and to monkeypatching `app.utils.absence_check.create_manager_notification`
in place of Jest's `jest.mock('../../src/utils/managerNotifications', ...)`."""
import datetime

import pytest

from app.utils.absence_check import run_absence_check_sweep


class TestRunAbsenceCheckSweep:
    async def test_notifies_the_manager_for_a_rep_with_no_attendance_row_past_their_business_dates_11pm_cutoff(
        self, mock_pool, monkeypatch
    ):
        calls = []

        async def fake_create_manager_notification(**kwargs):
            calls.append(kwargs)

        monkeypatch.setattr(
            "app.utils.absence_check.create_manager_notification", fake_create_manager_notification
        )
        mock_pool.queue_fetch(
            [{"employee_id": 4, "username": "divya", "business_date": datetime.date(2026, 8, 18)}]
        )

        await run_absence_check_sweep()

        assert len(calls) == 1
        kwargs = calls[0]
        assert kwargs["type"] == "day_absent"
        assert kwargs["severity"] == "danger"
        assert kwargs["employee_id"] == 4
        assert kwargs["business_date"] == datetime.date(2026, 8, 18)
        assert "divya" in kwargs["body"]

    async def test_notifies_once_per_employee_per_business_date_returned_by_the_query(self, mock_pool, monkeypatch):
        calls = []

        async def fake_create_manager_notification(**kwargs):
            calls.append(kwargs)

        monkeypatch.setattr(
            "app.utils.absence_check.create_manager_notification", fake_create_manager_notification
        )
        mock_pool.queue_fetch(
            [
                {"employee_id": 4, "username": "divya", "business_date": datetime.date(2026, 8, 18)},
                {"employee_id": 6, "username": "arun", "business_date": datetime.date(2026, 8, 17)},
            ]
        )

        await run_absence_check_sweep()

        assert len(calls) == 2

    async def test_query_excludes_business_dates_before_the_employee_was_created(self, mock_pool, monkeypatch):
        # A rep created on e.g. Aug 28 must not be flagged absent for Aug 26/27
        # (dates before their account existed) even though those dates fall
        # inside the sweep's lookback window.
        async def fake_create_manager_notification(**kwargs):
            pass

        monkeypatch.setattr(
            "app.utils.absence_check.create_manager_notification", fake_create_manager_notification
        )
        mock_pool.queue_fetch([])

        await run_absence_check_sweep()

        query = mock_pool.fetch_calls[0].query
        assert "ed.business_date >=" in query
        assert "e.created_at" in query

    async def test_does_nothing_when_no_rep_is_eligible(self, mock_pool, monkeypatch):
        calls = []

        async def fake_create_manager_notification(**kwargs):
            calls.append(kwargs)

        monkeypatch.setattr(
            "app.utils.absence_check.create_manager_notification", fake_create_manager_notification
        )
        mock_pool.queue_fetch([])

        await run_absence_check_sweep()

        assert calls == []

    async def test_does_not_throw_if_the_sweep_itself_fails(self, mock_pool, monkeypatch):
        async def fake_create_manager_notification(**kwargs):
            pass

        monkeypatch.setattr(
            "app.utils.absence_check.create_manager_notification", fake_create_manager_notification
        )
        mock_pool.queue_fetch(Exception("db down"))

        # should not raise
        await run_absence_check_sweep()

    async def test_one_failed_notification_does_not_stop_the_rest_from_being_sent(self, mock_pool, monkeypatch):
        calls = []

        async def fake_create_manager_notification(**kwargs):
            calls.append(kwargs)
            if len(calls) == 1:
                raise Exception("notification service down")

        monkeypatch.setattr(
            "app.utils.absence_check.create_manager_notification", fake_create_manager_notification
        )
        mock_pool.queue_fetch(
            [
                {"employee_id": 4, "username": "divya", "business_date": datetime.date(2026, 8, 18)},
                {"employee_id": 6, "username": "arun", "business_date": datetime.date(2026, 8, 18)},
            ]
        )

        await run_absence_check_sweep()

        assert len(calls) == 2
