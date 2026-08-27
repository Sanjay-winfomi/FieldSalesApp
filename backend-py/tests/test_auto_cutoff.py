"""Ported from backend/tests/utils/autoCutoff.test.js — same test intent,
same assertions, adapted to FakePool's queue-based mocking (see
tests/helpers/fake_pool.py) in place of Jest's `pool.query.mockResolvedValueOnce`,
and to monkeypatching `app.utils.auto_cutoff.create_manager_notification` in
place of Jest's `jest.mock('../../src/utils/managerNotifications', ...)`.

Note: Node's pool.query() backs both the RETURNING-rows UPDATEs and the
single-row lookups with the one mock queue; the Python port splits these
across pool.fetch() (multi-row) and pool.fetchrow() (single-row), so the
queuing below is split into mock_pool.queue_fetch(...)/queue_fetchrow(...)
calls in the same overall order Node's chained .mockResolvedValueOnce(...)
calls represent."""
import pytest

from app.utils.auto_cutoff import run_auto_cutoff_sweep


class TestRunAutoCutoffSweep:
    async def test_closes_an_open_dealer_visit_past_the_1am_cutoff_and_notifies_the_manager(
        self, mock_pool, monkeypatch
    ):
        calls = []

        async def fake_create_manager_notification(**kwargs):
            calls.append(kwargs)

        monkeypatch.setattr("app.utils.auto_cutoff.create_manager_notification", fake_create_manager_notification)

        mock_pool.queue_fetch(
            [{"id": 10, "attendance_id": 5, "dealer_id": 3, "visit_duration_minutes": 480}]
        )  # UPDATE client_visits
        mock_pool.queue_fetchrow(
            {"employee_id": 1, "username": "arun", "dealer_name": "Dealer A"}
        )  # employee/dealer lookup
        mock_pool.queue_fetch([])  # UPDATE attendance -- none open

        await run_auto_cutoff_sweep()

        assert len(calls) == 1
        kwargs = calls[0]
        assert kwargs["type"] == "visit_auto_cutoff"
        assert kwargs["employee_id"] == 1
        assert kwargs["dealer_id"] == 3
        assert kwargs["visit_id"] == 10
        assert "arun" in kwargs["body"]
        assert "Dealer A" in kwargs["body"]
        assert "8.0h" in kwargs["body"]

    async def test_closes_an_open_day_attendance_past_the_1am_cutoff_and_notifies_the_manager(
        self, mock_pool, monkeypatch
    ):
        calls = []

        async def fake_create_manager_notification(**kwargs):
            calls.append(kwargs)

        monkeypatch.setattr("app.utils.auto_cutoff.create_manager_notification", fake_create_manager_notification)

        mock_pool.queue_fetch([])  # UPDATE client_visits -- none open
        mock_pool.queue_fetch(
            [{"id": 7, "employee_id": 2, "total_duration_minutes": 600}]
        )  # UPDATE attendance
        mock_pool.queue_fetchrow({"username": "priya"})  # employee lookup

        await run_auto_cutoff_sweep()

        assert len(calls) == 1
        kwargs = calls[0]
        assert kwargs["type"] == "day_auto_cutoff"
        assert kwargs["employee_id"] == 2
        assert "priya" in kwargs["body"]
        assert "10.0h" in kwargs["body"]

    async def test_does_nothing_when_nothing_is_open_past_cutoff(self, mock_pool, monkeypatch):
        calls = []

        async def fake_create_manager_notification(**kwargs):
            calls.append(kwargs)

        monkeypatch.setattr("app.utils.auto_cutoff.create_manager_notification", fake_create_manager_notification)

        mock_pool.queue_fetch([])
        mock_pool.queue_fetch([])

        await run_auto_cutoff_sweep()

        assert calls == []

    async def test_does_not_throw_if_the_sweep_itself_fails(self, mock_pool, monkeypatch):
        async def fake_create_manager_notification(**kwargs):
            pass

        monkeypatch.setattr("app.utils.auto_cutoff.create_manager_notification", fake_create_manager_notification)

        mock_pool.queue_fetch(Exception("db down"))

        # should not raise
        await run_auto_cutoff_sweep()
