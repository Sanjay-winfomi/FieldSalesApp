"""Ported from backend/tests/routes/followupRequests.routes.test.js — same
test intent, same assertions, adapted to FakePool's queue-based mocking (see
tests/helpers/fake_pool.py) in place of Jest's `pool.query.mockResolvedValueOnce`
/ the hand-rolled `mockClient()` stub.

Node's PATCH /:id/approve runs its assignment-creating half inside a
transaction via `pool.connect()`, not `pool.query()` directly — the Python
port's equivalent is `pool.get_pool().acquire()` returning a FakeConnection
that shares FakePool's queues (see fake_pool.py's module docstring), so the
same `mock_pool.queue_fetchrow(...)`/`queue_execute(...)` calls back both the
module-level `pool.fetchrow` reads (existence check, reject) AND the
transactional connection's `conn.fetchrow`/`conn.execute` calls (approve) —
matching how a single Jest mockClient.query() queue backs both pool.query()
and client.query() in the Node tests.

app.services.idempotency and app.services.manager_notifications are mocked
the same way Node's jest.mock('../../src/utils/idempotency', ...) and
jest.mock('../../src/utils/managerNotifications', ...) are: idempotency's two
functions are patched on the `idempotency` module object itself (the router
imports the module, `from app.services import idempotency`, and calls
`idempotency.get_idempotent_response(...)` / `idempotency.save_idempotent_response(...)`
through it), while create_manager_notification is patched on the router
module's own namespace (`app.routers.followup_requests.create_manager_notification`)
since the router imports that name directly.
"""
import datetime
from unittest.mock import AsyncMock

import pytest

from app.core.security import Employee
from app.routers import followup_requests as followup_requests_router_module
from tests.helpers.test_app import make_client

REP = Employee(id=1, role="rep", username="arun")
MANAGER = Employee(id=99, role="manager", username="priya")

FUTURE_DATE = "2099-01-01"
LONG_REASON = "Dealer asked to come back tomorrow instead"


@pytest.fixture
def rep_client():
    return make_client(followup_requests_router_module.router, prefix="/api/x", employee=REP)


@pytest.fixture
def manager_client():
    return make_client(followup_requests_router_module.router, prefix="/api/x", employee=MANAGER)


@pytest.fixture(autouse=True)
def mocked_services(monkeypatch):
    """Mirrors the Node file's module-level jest.mock(...) calls — every test
    gets fresh AsyncMocks for get_idempotent_response/save_idempotent_response
    (default: no cached response, no-op save) and create_manager_notification
    (default: no-op), same as Jest's auto-mocked jest.fn() returning
    undefined unless a test overrides it."""
    get_idempotent_response = AsyncMock(return_value=None)
    save_idempotent_response = AsyncMock(return_value=None)
    create_manager_notification = AsyncMock(return_value=None)
    monkeypatch.setattr(
        followup_requests_router_module.idempotency, "get_idempotent_response", get_idempotent_response
    )
    monkeypatch.setattr(
        followup_requests_router_module.idempotency, "save_idempotent_response", save_idempotent_response
    )
    monkeypatch.setattr(
        followup_requests_router_module, "create_manager_notification", create_manager_notification
    )
    return {
        "get_idempotent_response": get_idempotent_response,
        "save_idempotent_response": save_idempotent_response,
        "create_manager_notification": create_manager_notification,
    }


class TestCreateFollowupRequest:
    async def test_400_when_dealer_id_is_missing(self, rep_client, mock_pool):
        async with rep_client as c:
            res = await c.post("/api/x", json={"requested_date": FUTURE_DATE, "reason": LONG_REASON})
        assert res.status_code == 400

    async def test_403_when_a_manager_tries_to_create_a_followup_request(self, manager_client, mock_pool):
        async with manager_client as c:
            res = await c.post(
                "/api/x", json={"dealer_id": 5, "requested_date": FUTURE_DATE, "reason": LONG_REASON}
            )
        assert res.status_code == 403

    async def test_422_when_requested_date_is_in_the_past(self, rep_client, mock_pool):
        async with rep_client as c:
            res = await c.post(
                "/api/x", json={"dealer_id": 5, "requested_date": "2020-01-01", "reason": LONG_REASON}
            )
        assert res.status_code == 422
        assert res.json()["error"] == "requested_date_in_past"

    async def test_422_when_reason_is_too_short(self, rep_client, mock_pool):
        async with rep_client as c:
            res = await c.post(
                "/api/x", json={"dealer_id": 5, "requested_date": FUTURE_DATE, "reason": "short"}
            )
        assert res.status_code == 422
        assert res.json()["error"] == "reason_too_short"

    async def test_404_when_the_dealer_does_not_exist(self, rep_client, mock_pool):
        mock_pool.queue_fetchrow(None)
        async with rep_client as c:
            res = await c.post(
                "/api/x", json={"dealer_id": 5, "requested_date": FUTURE_DATE, "reason": LONG_REASON}
            )
        assert res.status_code == 404

    async def test_201_creates_the_request_and_notifies_managers(self, rep_client, mock_pool, mocked_services):
        mock_pool.queue_fetchrow({"id": 5, "name": "Dealer A"})  # dealer lookup
        mock_pool.queue_fetchrow(
            {
                "id": 20,
                "employee_id": REP.id,
                "dealer_id": 5,
                "requested_date": FUTURE_DATE,
                "reason": LONG_REASON,
                "status": "pending",
            }
        )  # insert

        async with rep_client as c:
            res = await c.post(
                "/api/x", json={"dealer_id": 5, "requested_date": FUTURE_DATE, "reason": LONG_REASON}
            )

        assert res.status_code == 201
        assert res.json()["request"]["id"] == 20
        mocked_services["create_manager_notification"].assert_awaited_once()
        _, kwargs = mocked_services["create_manager_notification"].call_args
        assert kwargs["type"] == "followup_request"
        assert kwargs["employee_id"] == REP.id
        assert kwargs["dealer_id"] == 5
        assert kwargs["followup_request_id"] == 20

    async def test_idempotency_key_replay_returns_cached_response_without_inserting_again(
        self, rep_client, mock_pool, mocked_services
    ):
        # getIdempotentResponse's SELECT finds a row from the original attempt.
        mocked_services["get_idempotent_response"].return_value = {
            "response_status": 201,
            "response_body": {"request": {"id": 20, "status": "pending"}},
        }

        async with rep_client as c:
            res = await c.post(
                "/api/x",
                headers={"Idempotency-Key": "retry-key-1"},
                json={"dealer_id": 5, "requested_date": FUTURE_DATE, "reason": LONG_REASON},
            )

        assert res.status_code == 201
        assert res.json()["request"]["id"] == 20
        # Only the idempotency lookup ran — no dealer lookup, no second insert.
        assert mock_pool.fetch_calls == []
        assert mock_pool.fetchrow_calls == []
        assert mock_pool.execute_calls == []
        mocked_services["create_manager_notification"].assert_not_awaited()

    async def test_fresh_idempotency_key_still_creates_the_request_and_saves_the_response(
        self, rep_client, mock_pool, mocked_services
    ):
        mock_pool.queue_fetchrow({"id": 5, "name": "Dealer A"})  # dealer lookup
        mock_pool.queue_fetchrow(
            {
                "id": 20,
                "employee_id": REP.id,
                "dealer_id": 5,
                "requested_date": FUTURE_DATE,
                "reason": LONG_REASON,
                "status": "pending",
            }
        )  # insert

        async with rep_client as c:
            res = await c.post(
                "/api/x",
                headers={"Idempotency-Key": "fresh-key-1"},
                json={"dealer_id": 5, "requested_date": FUTURE_DATE, "reason": LONG_REASON},
            )

        assert res.status_code == 201
        assert res.json()["request"]["id"] == 20
        mocked_services["create_manager_notification"].assert_awaited_once()
        mocked_services["save_idempotent_response"].assert_awaited_once()
        save_args, _ = mocked_services["save_idempotent_response"].call_args
        assert save_args[0] == "fresh-key-1"
        assert save_args[1] == REP.id
        assert save_args[2] == "followup-requests"
        assert save_args[3] == 201

    async def test_404_when_assignment_id_does_not_belong_to_the_requesting_rep(self, rep_client, mock_pool):
        mock_pool.queue_fetchrow({"id": 5, "name": "Dealer A"})  # dealer lookup
        mock_pool.queue_fetchrow(None)  # assignment lookup finds nothing for this employee

        async with rep_client as c:
            res = await c.post(
                "/api/x",
                json={
                    "dealer_id": 5,
                    "assignment_id": 999,
                    "requested_date": FUTURE_DATE,
                    "reason": LONG_REASON,
                },
            )

        assert res.status_code == 404


class TestListFollowupRequests:
    async def test_403_when_a_rep_tries_to_list_requests(self, rep_client, mock_pool):
        async with rep_client as c:
            res = await c.get("/api/x")
        assert res.status_code == 403

    async def test_400_on_an_invalid_status_filter(self, manager_client, mock_pool):
        async with manager_client as c:
            res = await c.get("/api/x", params={"status": "bogus"})
        assert res.status_code == 400

    async def test_200_lists_requests_filtered_by_status_when_given(self, manager_client, mock_pool):
        mock_pool.queue_fetch([{"id": 20, "status": "pending"}])
        async with manager_client as c:
            res = await c.get("/api/x", params={"status": "pending"})
        assert res.status_code == 200
        assert len(res.json()["requests"]) == 1
        assert mock_pool.fetch_calls[0].args == ("pending",)


class TestApproveFollowupRequest:
    async def test_403_when_a_rep_tries_to_approve(self, rep_client, mock_pool):
        async with rep_client as c:
            res = await c.patch("/api/x/20/approve")
        assert res.status_code == 403

    async def test_404_when_the_request_does_not_exist(self, manager_client, mock_pool):
        mock_pool.queue_fetchrow(None)  # existing — not found
        async with manager_client as c:
            res = await c.patch("/api/x/20/approve")
        assert res.status_code == 404

    async def test_409_when_the_request_was_already_resolved(self, manager_client, mock_pool):
        mock_pool.queue_fetchrow({"id": 20, "status": "approved"})  # existing — already resolved
        async with manager_client as c:
            res = await c.patch("/api/x/20/approve")
        assert res.status_code == 409

    async def test_200_creates_the_assignment_at_the_next_sequence_position_and_marks_the_request_approved(
        self, manager_client, mock_pool
    ):
        mock_pool.queue_fetchrow(
            {
                "id": 20,
                "employee_id": REP.id,
                "dealer_id": 5,
                "requested_date": FUTURE_DATE,
                "status": "pending",
            }
        )  # existing
        mock_pool.queue_execute("SELECT 1")  # advisory lock
        mock_pool.queue_fetchrow({"id": 20, "status": "approved"})  # atomic claim: update request status
        mock_pool.queue_fetchrow({"next_seq": 3})  # next sequence
        mock_pool.queue_fetchrow({"id": 555})  # insert assignment

        async with manager_client as c:
            res = await c.patch("/api/x/20/approve")

        assert res.status_code == 200
        body = res.json()
        assert body["assignment_id"] == 555
        assert body["request"]["status"] == "approved"
        # Insert-assignment call args: employee_id, dealer_id, approved_date, next_seq, manager_id
        insert_call = mock_pool.fetchrow_calls[3]
        assert insert_call.args == (REP.id, 5, datetime.date.fromisoformat(FUTURE_DATE), 3, MANAGER.id)

    async def test_409_when_an_approve_reject_race_already_resolved_the_request_between_the_check_and_the_atomic_claim(
        self, manager_client, mock_pool
    ):
        mock_pool.queue_fetchrow(
            {
                "id": 20,
                "employee_id": REP.id,
                "dealer_id": 5,
                "requested_date": FUTURE_DATE,
                "status": "pending",
            }
        )  # existing (still pending at read time)
        mock_pool.queue_execute("SELECT 1")  # advisory lock
        mock_pool.queue_fetchrow(None)  # atomic claim finds 0 rows — a concurrent request already resolved it

        async with manager_client as c:
            res = await c.patch("/api/x/20/approve")

        assert res.status_code == 409
        assert res.json()["error"] == "request_already_resolved"
        # No assignment side effect — the claim UPDATE was the last real write:
        # only 2 fetchrow calls happened (existing + claim), no next-seq/insert.
        assert len(mock_pool.fetchrow_calls) == 2

    OVERRIDE_DATE = "2099-02-02"

    async def test_manager_supplied_approved_date_is_used_instead_of_the_reps_requested_date(
        self, manager_client, mock_pool
    ):
        mock_pool.queue_fetchrow(
            {
                "id": 20,
                "employee_id": REP.id,
                "dealer_id": 5,
                "requested_date": FUTURE_DATE,
                "status": "pending",
            }
        )
        mock_pool.queue_execute("SELECT 1")  # advisory lock
        mock_pool.queue_fetchrow(
            {"id": 20, "status": "approved", "approved_date": self.OVERRIDE_DATE}
        )
        mock_pool.queue_fetchrow({"next_seq": 1})
        mock_pool.queue_fetchrow({"id": 555})

        async with manager_client as c:
            res = await c.patch("/api/x/20/approve", json={"approved_date": self.OVERRIDE_DATE})

        assert res.status_code == 200
        assert res.json()["request"]["approved_date"] == self.OVERRIDE_DATE

        override_date_val = datetime.date.fromisoformat(self.OVERRIDE_DATE)
        # fetchrow order: [0] existing, [1] claim UPDATE, [2] next-seq, [3] insert
        # claim UPDATE args: approved_date, manager_id, request_id
        claim_call = mock_pool.fetchrow_calls[1]
        assert claim_call.args == (override_date_val, MANAGER.id, 20)
        # next-sequence lookup args: employee_id, approved_date
        next_seq_call = mock_pool.fetchrow_calls[2]
        assert next_seq_call.args == (REP.id, override_date_val)
        # assignment insert args: employee_id, dealer_id, approved_date, next_seq, manager_id
        insert_call = mock_pool.fetchrow_calls[3]
        assert insert_call.args == (REP.id, 5, override_date_val, 1, MANAGER.id)

    async def test_400_when_approved_date_is_not_a_valid_date(self, manager_client, mock_pool):
        mock_pool.queue_fetchrow(
            {
                "id": 20,
                "employee_id": REP.id,
                "dealer_id": 5,
                "requested_date": FUTURE_DATE,
                "status": "pending",
            }
        )
        async with manager_client as c:
            res = await c.patch("/api/x/20/approve", json={"approved_date": "not-a-date"})
        assert res.status_code == 400

    async def test_422_when_approved_date_is_in_the_past(self, manager_client, mock_pool):
        mock_pool.queue_fetchrow(
            {
                "id": 20,
                "employee_id": REP.id,
                "dealer_id": 5,
                "requested_date": FUTURE_DATE,
                "status": "pending",
            }
        )
        async with manager_client as c:
            res = await c.patch("/api/x/20/approve", json={"approved_date": "2020-01-01"})
        assert res.status_code == 422
        assert res.json()["error"] == "approved_date_in_past"


class TestRejectFollowupRequest:
    async def test_403_when_a_rep_tries_to_reject(self, rep_client, mock_pool):
        async with rep_client as c:
            res = await c.patch("/api/x/20/reject")
        assert res.status_code == 403

    async def test_409_when_the_request_was_already_resolved(self, manager_client, mock_pool):
        mock_pool.queue_fetchrow({"status": "rejected"})
        async with manager_client as c:
            res = await c.patch("/api/x/20/reject")
        assert res.status_code == 409

    async def test_200_marks_the_request_rejected(self, manager_client, mock_pool):
        mock_pool.queue_fetchrow({"status": "pending"})
        mock_pool.queue_fetchrow({"id": 20, "status": "rejected"})

        async with manager_client as c:
            res = await c.patch("/api/x/20/reject")

        assert res.status_code == 200
        assert res.json()["request"]["status"] == "rejected"

    async def test_409_when_an_approve_reject_race_already_resolved_the_request_between_the_check_and_the_atomic_claim(
        self, manager_client, mock_pool
    ):
        mock_pool.queue_fetchrow({"status": "pending"})  # still pending at read time
        mock_pool.queue_fetchrow(None)  # atomic claim finds 0 rows — a concurrent approve already resolved it

        async with manager_client as c:
            res = await c.patch("/api/x/20/reject")

        assert res.status_code == 409
        assert res.json()["error"] == "request_already_resolved"
