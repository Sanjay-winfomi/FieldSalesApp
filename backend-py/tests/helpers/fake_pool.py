"""
fake_pool.py — a DB-mocking harness for route unit tests, playing the same
role backend/tests/**/*.test.js's `jest.mock('../../src/db/pool', ...)` +
per-test `pool.query.mockResolvedValueOnce(...)` plays for the Node suite.

asyncpg's client surface is wider than node-pg's single `.query()` method —
routes call `pool.fetch` / `pool.fetchrow` / `pool.execute` (module-level,
autocommit) and, for transactional routes, `pool.get_pool().acquire()` to
get a raw connection with its own `.fetch`/`.fetchrow`/`.execute` plus
`.transaction()`. FakePool below backs ALL of these with one shared,
call-in-order queue per statement KIND (fetch/fetchrow/execute) — a test
queues expected results in the exact order the route under test will
request them, same as Jest's `mockResolvedValueOnce` chaining, just split
across three queues instead of one because asyncpg's API is split three ways.

Usage in a test:

    async def test_something(mock_pool):
        mock_pool.queue_fetchrow({"id": 1, "role": "rep"})   # e.g. an auth lookup
        mock_pool.queue_fetchrow(None)                        # "not found"
        mock_pool.queue_execute("UPDATE 1")                   # asyncpg's execute() return shape
        response = await client.get(...)
        assert mock_pool.fetchrow_calls[0].query.startswith("SELECT")

Each queued value may also be an Exception instance, raised instead of
returned when popped — for simulating a DB failure.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


class Empty:
    pass


_EMPTY = Empty()


@dataclass
class RecordedCall:
    query: str
    args: tuple


class _QueueMixin:
    def __init__(self):
        self._fetch_queue: list[Any] = []
        self._fetchrow_queue: list[Any] = []
        self._execute_queue: list[Any] = []
        self.fetch_calls: list[RecordedCall] = []
        self.fetchrow_calls: list[RecordedCall] = []
        self.execute_calls: list[RecordedCall] = []

    def queue_fetch(self, value):
        self._fetch_queue.append(value)

    def queue_fetchrow(self, value):
        self._fetchrow_queue.append(value)

    def queue_execute(self, value="UPDATE 1"):
        self._execute_queue.append(value)

    def _pop(self, queue: list, calls: list, query: str, args: tuple, kind: str):
        calls.append(RecordedCall(query=query, args=args))
        if not queue:
            raise AssertionError(
                f"FakePool.{kind}() called with no queued result — "
                f"query={query!r} args={args!r}. Queue a result with "
                f"mock_pool.queue_{kind}(...) before the call that triggers it."
            )
        value = queue.pop(0)
        if isinstance(value, BaseException):
            raise value
        return value

    async def fetch(self, query: str, *args):
        return self._pop(self._fetch_queue, self.fetch_calls, query, args, "fetch")

    async def fetchrow(self, query: str, *args):
        return self._pop(self._fetchrow_queue, self.fetchrow_calls, query, args, "fetchrow")

    async def execute(self, query: str, *args):
        return self._pop(self._execute_queue, self.execute_calls, query, args, "execute")

    async def fetchval(self, query: str, *args):
        row = await self.fetchrow(query, *args)
        if row is None:
            return None
        if isinstance(row, dict):
            return next(iter(row.values()))
        return row


class FakeTransaction:
    def __init__(self):
        self.started = False
        self.committed = False
        self.rolled_back = False

    async def start(self):
        self.started = True

    async def commit(self):
        self.committed = True

    async def rollback(self):
        self.rolled_back = True


class FakeConnection(_QueueMixin):
    """Backs `conn = await pool.get_pool().acquire()` — shares its parent
    FakePool's queues so a transactional route's conn.fetchrow(...) calls
    consume from the SAME ordered queue as module-level pool.fetchrow(...)
    calls, matching how a single Jest mockClient.query() queue backs both
    pool.query() and client.query() in the Node tests."""

    def __init__(self, parent: "FakePool"):
        self._parent = parent
        self.transactions: list[FakeTransaction] = []

    def transaction(self) -> FakeTransaction:
        tx = FakeTransaction()
        self.transactions.append(tx)
        return tx

    async def fetch(self, query: str, *args):
        return await self._parent.fetch(query, *args)

    async def fetchrow(self, query: str, *args):
        return await self._parent.fetchrow(query, *args)

    async def execute(self, query: str, *args):
        return await self._parent.execute(query, *args)


class FakePool(_QueueMixin):
    def __init__(self):
        super().__init__()
        self.released_connections: list[FakeConnection] = []

    def get_pool(self) -> "FakePool":
        # app.db.pool.get_pool() normally returns the real asyncpg.Pool;
        # routes call `.acquire()` / `.release()` on whatever it returns.
        # Returning self here lets the same FakePool instance serve both
        # roles in tests.
        return self

    async def acquire(self) -> FakeConnection:
        return FakeConnection(self)

    async def release(self, conn: FakeConnection):
        self.released_connections.append(conn)
