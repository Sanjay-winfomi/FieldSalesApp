"""Ported from backend/tests/routes/reminders.routes.test.js — same test
intent, same assertions, adapted to FakePool's queue-based mocking (see
tests/helpers/fake_pool.py) in place of Jest's `pool.query.mockResolvedValueOnce`."""
from datetime import date

import pytest

from app.core.security import Employee
from app.routers import reminders as reminders_router_module
from tests.helpers.test_app import make_client

REP = Employee(id=1, role="rep", username="arun")
OTHER_REP = Employee(id=2, role="rep", username="divya")
MANAGER = Employee(id=99, role="manager", username="priya")

LONG_NOTE = "Follow up on the pending order and payment"
SHORT_NOTE = "too short"
FUTURE_DATE = "2099-01-01"
PAST_DATE = "2000-01-01"


def make_reminders_client(employee):
    return make_client(reminders_router_module.router, prefix="/api/x", employee=employee)


class TestCreateReminder:
    async def test_400_when_dealer_id_is_not_an_integer(self, mock_pool):
        client = make_reminders_client(REP)
        async with client as c:
            res = await c.post(
                "/api/x",
                json={"dealer_id": "abc", "reminder_date": FUTURE_DATE, "note": LONG_NOTE},
            )
        assert res.status_code == 400

    async def test_400_when_reminder_date_is_not_a_valid_date(self, mock_pool):
        client = make_reminders_client(REP)
        async with client as c:
            res = await c.post(
                "/api/x",
                json={"dealer_id": 2, "reminder_date": "not-a-date", "note": LONG_NOTE},
            )
        assert res.status_code == 400

    async def test_422_when_reminder_date_is_in_the_past(self, mock_pool):
        client = make_reminders_client(REP)
        async with client as c:
            res = await c.post(
                "/api/x",
                json={"dealer_id": 2, "reminder_date": PAST_DATE, "note": LONG_NOTE},
            )
        assert res.status_code == 422
        assert res.json()["error"] == "reminder_date_in_past"

    async def test_422_when_note_is_under_20_characters(self, mock_pool):
        client = make_reminders_client(REP)
        async with client as c:
            res = await c.post(
                "/api/x",
                json={"dealer_id": 2, "reminder_date": FUTURE_DATE, "note": SHORT_NOTE},
            )
        assert res.status_code == 422
        assert res.json()["error"] == "note_too_short"

    async def test_404_when_the_dealer_does_not_exist(self, mock_pool):
        mock_pool.queue_fetchrow(None)
        client = make_reminders_client(REP)
        async with client as c:
            res = await c.post(
                "/api/x",
                json={"dealer_id": 999, "reminder_date": FUTURE_DATE, "note": LONG_NOTE},
            )
        assert res.status_code == 404

    async def test_201_creates_a_reminder_for_the_authenticated_employee(self, mock_pool):
        mock_pool.queue_fetchrow({"id": 2})  # dealer exists
        mock_pool.queue_fetchrow(
            {"id": 5, "employee_id": REP.id, "dealer_id": 2, "reminder_date": FUTURE_DATE, "note": LONG_NOTE}
        )
        client = make_reminders_client(REP)
        async with client as c:
            res = await c.post(
                "/api/x",
                json={"dealer_id": 2, "reminder_date": FUTURE_DATE, "note": LONG_NOTE},
            )
        assert res.status_code == 201
        assert res.json()["reminder"]["id"] == 5
        insert_call = mock_pool.fetchrow_calls[1]
        assert insert_call.args == (REP.id, 2, date(2099, 1, 1), LONG_NOTE)


class TestListReminders:
    async def test_200_lists_the_callers_own_reminders_with_dealer_name(self, mock_pool):
        mock_pool.queue_fetch(
            [{"id": 1, "employee_id": REP.id, "dealer_id": 2, "dealer_name": "Anand Tiles", "note": LONG_NOTE}]
        )
        client = make_reminders_client(REP)
        async with client as c:
            res = await c.get("/api/x")
        assert res.status_code == 200
        body = res.json()
        assert len(body["reminders"]) == 1
        assert body["reminders"][0]["dealer_name"] == "Anand Tiles"
        assert mock_pool.fetch_calls[0].args == (REP.id,)

    async def test_manager_can_pass_employee_id_to_view_a_reps_reminders(self, mock_pool):
        mock_pool.queue_fetch([])
        client = make_reminders_client(MANAGER)
        async with client as c:
            res = await c.get("/api/x", params={"employee_id": REP.id})
        assert res.status_code == 200
        assert mock_pool.fetch_calls[0].args == (REP.id,)

    async def test_400_when_a_manager_passes_an_invalid_employee_id(self, mock_pool):
        client = make_reminders_client(MANAGER)
        async with client as c:
            res = await c.get("/api/x", params={"employee_id": "abc"})
        assert res.status_code == 400

    async def test_rep_passing_employee_id_is_ignored_still_sees_only_their_own(self, mock_pool):
        mock_pool.queue_fetch([])
        client = make_reminders_client(REP)
        async with client as c:
            res = await c.get("/api/x", params={"employee_id": OTHER_REP.id})
        assert res.status_code == 200
        assert mock_pool.fetch_calls[0].args == (REP.id,)


class TestUpdateReminderNotifications:
    async def test_404_when_reminder_does_not_exist(self, mock_pool):
        mock_pool.queue_fetchrow(None)
        client = make_reminders_client(REP)
        async with client as c:
            res = await c.patch(
                "/api/x/5/notifications", json={"notif_id_day_before": "a", "notif_id_day_of": "b"}
            )
        assert res.status_code == 404

    async def test_403_when_a_rep_edits_another_reps_reminder(self, mock_pool):
        mock_pool.queue_fetchrow({"employee_id": OTHER_REP.id})
        client = make_reminders_client(REP)
        async with client as c:
            res = await c.patch(
                "/api/x/5/notifications", json={"notif_id_day_before": "a", "notif_id_day_of": "b"}
            )
        assert res.status_code == 403

    async def test_200_persists_the_notification_ids(self, mock_pool):
        mock_pool.queue_fetchrow({"employee_id": REP.id})
        mock_pool.queue_fetchrow({"id": 5, "notif_id_day_before": "a", "notif_id_day_of": "b"})
        client = make_reminders_client(REP)
        async with client as c:
            res = await c.patch(
                "/api/x/5/notifications", json={"notif_id_day_before": "a", "notif_id_day_of": "b"}
            )
        assert res.status_code == 200
        assert res.json()["reminder"]["notif_id_day_before"] == "a"


class TestDeleteReminder:
    async def test_404_when_reminder_does_not_exist(self, mock_pool):
        mock_pool.queue_fetchrow(None)
        client = make_reminders_client(REP)
        async with client as c:
            res = await c.delete("/api/x/5")
        assert res.status_code == 404

    async def test_403_when_a_rep_deletes_another_reps_reminder(self, mock_pool):
        mock_pool.queue_fetchrow({"employee_id": OTHER_REP.id})
        client = make_reminders_client(REP)
        async with client as c:
            res = await c.delete("/api/x/5")
        assert res.status_code == 403

    async def test_200_deletes_the_reminder(self, mock_pool):
        mock_pool.queue_fetchrow({"employee_id": REP.id})
        mock_pool.queue_execute("DELETE 1")
        client = make_reminders_client(REP)
        async with client as c:
            res = await c.delete("/api/x/5")
        assert res.status_code == 200
        assert res.json()["success"] is True
