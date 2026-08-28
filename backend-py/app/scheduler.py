"""
scheduler.py — replaces the Node app's import-time setTimeout/setInterval
sweeps with APScheduler jobs registered explicitly at FastAPI startup
(see main.py's lifespan). Same intervals as the Node code:
  - auto_cutoff / absence_check: 30s startup delay, then every 15 minutes
  - idempotency cleanup: every 1 hour
  - employee-state cache sweep: every 30 seconds (in-process only, no lock
    needed — see app.core.security)

Multi-worker safety (Phase 4): the Node app was always a single process, so
these sweeps never needed to worry about two instances racing on the same
tick. If this FastAPI deployment ever runs more than one worker, running the
same sweep concurrently in each would be wasted work (not corrupting —
absence_check/auto_cutoff are idempotent UPDATE...WHERE queries and
absence_check's insert is guarded by a DB-level partial unique index — but
still wasted DB round trips every tick). `_with_advisory_lock` takes a
non-blocking `pg_try_advisory_lock` around each sweep so only one worker
actually runs it per tick; the others no-op and return immediately.
"""
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

from app.core.logging_config import log_error
from app.core.security import sweep_expired_employee_state_cache
from app.db import pool
from app.services.idempotency import cleanup_old_idempotency_keys
from app.utils.absence_check import run_absence_check_sweep
from app.utils.auto_cutoff import run_auto_cutoff_sweep

SWEEP_INTERVAL_SECONDS = 15 * 60
STARTUP_DELAY_SECONDS = 30
IDEMPOTENCY_CLEANUP_INTERVAL_SECONDS = 60 * 60
EMPLOYEE_CACHE_SWEEP_INTERVAL_SECONDS = 30

# Arbitrary fixed lock keys, one per sweep — must stay stable across
# deploys/restarts so concurrent workers actually contend on the same key.
_LOCK_KEY_AUTO_CUTOFF = 911_001
_LOCK_KEY_ABSENCE_CHECK = 911_002


async def _with_advisory_lock(lock_key: int, fn) -> None:
    conn = await pool.get_pool().acquire()
    try:
        acquired = await conn.fetchval("SELECT pg_try_advisory_lock($1)", lock_key)
        if not acquired:
            return
        try:
            await fn()
        finally:
            await conn.fetchval("SELECT pg_advisory_unlock($1)", lock_key)
    except Exception as err:  # noqa: BLE001
        log_error("Advisory-locked sweep failed to run", lock_key=lock_key, error=str(err))
    finally:
        await pool.get_pool().release(conn)


async def _guarded_auto_cutoff() -> None:
    await _with_advisory_lock(_LOCK_KEY_AUTO_CUTOFF, run_auto_cutoff_sweep)


async def _guarded_absence_check() -> None:
    await _with_advisory_lock(_LOCK_KEY_ABSENCE_CHECK, run_absence_check_sweep)


scheduler = AsyncIOScheduler()


def start_scheduler() -> None:
    # AsyncIOScheduler.start() only calls asyncio.get_running_loop() the
    # FIRST time it's ever started (`if not self._eventloop`) — after a
    # shutdown, self._eventloop still holds a reference to that original,
    # now-closed loop, so restarting the same instance within the same
    # process raises "RuntimeError: Event loop is closed" the moment a job
    # fires. A real deployment only ever starts this once per process, so
    # this never surfaces in production — but a fresh instance per start
    # makes start/stop safe to call more than once in the same process
    # (test harnesses that boot the app's lifespan more than once; a future
    # in-process restart hook), at zero cost to the single-boot case.
    global scheduler
    scheduler = AsyncIOScheduler()
    # IMPORTANT: do not pass next_run_time=None here — in APScheduler that
    # means "add this job PAUSED", not "wait a full interval before the
    # first run" (confirmed against APScheduler's own add_job docstring:
    # "pass None to add the job as paused"). Passing it on these four jobs
    # was a real bug: each recurring job would have been created paused and
    # NEVER resumed — after auto_cutoff/absence_check's one-shot startup
    # job fired once at T+30s, the "recurring" 15-minute sweep behind it
    # would silently never run again, and idempotency_cleanup/
    # employee_state_cache_sweep would never run at all. Omitting
    # next_run_time (leaving it at APScheduler's own `undefined` default)
    # lets IntervalTrigger compute its own correct first-fire time — for an
    # interval trigger with no explicit start_date, that's "now + one
    # interval", which is exactly Node's setInterval(fn, MS) semantics
    # (first call only after a full interval has elapsed, not immediately).
    scheduler.add_job(
        _guarded_auto_cutoff,
        trigger=IntervalTrigger(seconds=SWEEP_INTERVAL_SECONDS),
        id="auto_cutoff_sweep",
        replace_existing=True,
    )
    scheduler.add_job(
        _guarded_absence_check,
        trigger=IntervalTrigger(seconds=SWEEP_INTERVAL_SECONDS),
        id="absence_check_sweep",
        replace_existing=True,
    )
    scheduler.add_job(
        cleanup_old_idempotency_keys,
        trigger=IntervalTrigger(seconds=IDEMPOTENCY_CLEANUP_INTERVAL_SECONDS),
        id="idempotency_cleanup",
        replace_existing=True,
    )
    scheduler.add_job(
        sweep_expired_employee_state_cache,
        trigger=IntervalTrigger(seconds=EMPLOYEE_CACHE_SWEEP_INTERVAL_SECONDS),
        id="employee_state_cache_sweep",
        replace_existing=True,
    )

    # One-shot startup runs, same STARTUP_DELAY_MS the Node code uses,
    # scheduled as date-triggered jobs so the interval jobs above still fire
    # on their own regular cadence starting from process boot rather than
    # from this delayed first run.
    from datetime import datetime, timedelta, timezone

    run_at = datetime.now(timezone.utc) + timedelta(seconds=STARTUP_DELAY_SECONDS)
    scheduler.add_job(_guarded_auto_cutoff, trigger="date", run_date=run_at, id="auto_cutoff_startup")
    scheduler.add_job(_guarded_absence_check, trigger="date", run_date=run_at, id="absence_check_startup")

    scheduler.start()


def stop_scheduler() -> None:
    scheduler.shutdown(wait=False)
