"""Ported from backend/tests/utils/idempotency.test.js — same test intent,
same assertions, adapted to FakePool's queue-based mocking (see
tests/helpers/fake_pool.py) in place of Jest's `pool.query.mockResolvedValueOnce`.

Python's get_idempotent_response does `json.loads(row["response_body"])` —
asyncpg reads a jsonb column back as its raw text representation, not an
already-decoded object (unlike node-pg, which decodes jsonb columns to JS
objects automatically). A queued fetchrow result for this function must
therefore supply response_body as a JSON-encoded string, matching what a
real asyncpg row would contain — not a plain dict, or json.loads would
raise on a Python dict / TypeError."""
import json

import pytest

from app.services.idempotency import (
    cleanup_old_idempotency_keys,
    get_idempotent_response,
    save_idempotent_response,
)


class TestIdempotency:
    async def test_get_idempotent_response_returns_none_without_hitting_the_db_when_no_key_is_given(self, mock_pool):
        result = await get_idempotent_response(None, 1, "visits/login")
        assert result is None
        assert len(mock_pool.fetchrow_calls) == 0
        assert len(mock_pool.fetch_calls) == 0
        assert len(mock_pool.execute_calls) == 0

    async def test_save_idempotent_response_is_a_noop_without_hitting_the_db_when_no_key_is_given(self, mock_pool):
        await save_idempotent_response(None, 1, "visits/login", 201, {"ok": True})
        assert len(mock_pool.execute_calls) == 0

    async def test_get_idempotent_response_scopes_the_lookup_by_employee_id_and_endpoint_not_just_the_key(
        self, mock_pool
    ):
        mock_pool.queue_fetchrow(
            {"response_status": 201, "response_body": json.dumps({"ok": True})}
        )
        result = await get_idempotent_response("abc", 42, "visits/login")
        assert result == {"response_status": 201, "response_body": {"ok": True}}
        assert mock_pool.fetchrow_calls[0].args == ("abc", 42, "visits/login")

    async def test_cleanup_old_idempotency_keys_deletes_rows_older_than_the_retention_window(self, mock_pool):
        mock_pool.queue_execute("DELETE 0")
        await cleanup_old_idempotency_keys()
        query = mock_pool.execute_calls[0].query
        assert "DELETE FROM idempotency_keys" in query
        assert "created_at < NOW() - INTERVAL" in query

    async def test_cleanup_old_idempotency_keys_swallows_errors_instead_of_throwing(self, mock_pool):
        mock_pool.queue_execute(Exception("db down"))
        result = await cleanup_old_idempotency_keys()
        assert result is None
