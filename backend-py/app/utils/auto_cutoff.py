"""
auto_cutoff.py — ports autoCutoff.js exactly (same cutoff-instant SQL
expression, same UPDATE queries/side effects). Scheduling itself (30s
startup delay + 15-min recurring sweep) lives in app/scheduler.py — the Node
version started these as import-time side effects; APScheduler needs an
explicit registration, done once at app startup instead (see main.py).

Advisory-lock guarded (see app/scheduler.py) so that if the FastAPI
deployment ever runs more than one worker process, only one of them actually
executes a given sweep tick — the Node app never had this problem (always a
single process), so this is new to the port, not a behavior carried over.
"""
from app.core.logging_config import log_error, log_info
from app.db import pool
from app.services.manager_notifications import create_manager_notification

CUTOFF_INSTANT_EXPR = """(
  (CASE
     WHEN (NOW() AT TIME ZONE 'Asia/Kolkata')::time >= TIME '01:00:00'
       THEN DATE(NOW() AT TIME ZONE 'Asia/Kolkata')
     ELSE DATE(NOW() AT TIME ZONE 'Asia/Kolkata') - INTERVAL '1 day'
   END) + INTERVAL '1 hour'
) AT TIME ZONE 'Asia/Kolkata'"""


async def _cutoff_open_visits() -> int:
    rows = await pool.fetch(
        f"""
        UPDATE client_visits cv
        SET logout_time = {CUTOFF_INSTANT_EXPR},
            visit_duration_minutes = GREATEST(0, ROUND(EXTRACT(EPOCH FROM ({CUTOFF_INSTANT_EXPR} - cv.login_time)) / 60))::int,
            logout_justification_note = 'Auto-closed: rep did not log out of this dealer — cut off at 1:00 AM.'
        WHERE cv.logout_time IS NULL AND cv.login_time < {CUTOFF_INSTANT_EXPR}
        RETURNING cv.id, cv.attendance_id, cv.dealer_id, cv.visit_duration_minutes
        """
    )

    for visit in rows:
        try:
            info = await pool.fetchrow(
                """
                SELECT a.employee_id, e.username, d.name AS dealer_name
                FROM attendance a
                JOIN employees e ON e.id = a.employee_id
                JOIN dealers d ON d.id = $2
                WHERE a.id = $1
                """,
                visit["attendance_id"], visit["dealer_id"],
            )
            if info is None:
                continue
            hours = f"{visit['visit_duration_minutes'] / 60:.1f}"
            await create_manager_notification(
                type="visit_auto_cutoff",
                title="Dealer visit auto-closed (missed logout)",
                body=f"{info['username']} did not log out of {info['dealer_name']} — automatically closed at 1:00 AM after {hours}h.",
                severity="warning",
                employee_id=info["employee_id"],
                dealer_id=visit["dealer_id"],
                visit_id=visit["id"],
            )
        except Exception as err:  # noqa: BLE001
            log_error("Failed to notify for auto-cutoff visit", visit_id=visit["id"], error=str(err))

    return len(rows)


async def _cutoff_open_attendance() -> int:
    rows = await pool.fetch(
        f"""
        UPDATE attendance a
        SET logout_time = {CUTOFF_INSTANT_EXPR},
            total_duration_minutes = GREATEST(0, ROUND(EXTRACT(EPOCH FROM ({CUTOFF_INSTANT_EXPR} - a.login_time)) / 60))::int
        WHERE a.logout_time IS NULL AND a.login_time < {CUTOFF_INSTANT_EXPR}
        RETURNING a.id, a.employee_id, a.total_duration_minutes
        """
    )

    for att in rows:
        try:
            emp = await pool.fetchrow("SELECT username FROM employees WHERE id = $1", att["employee_id"])
            username = emp["username"] if emp is not None else f"Employee #{att['employee_id']}"
            hours = f"{att['total_duration_minutes'] / 60:.1f}"
            await create_manager_notification(
                type="day_auto_cutoff",
                title="Day auto-logged-out (missed logout)",
                body=f"{username} did not log out for the day — automatically closed at 1:00 AM after {hours}h.",
                severity="warning",
                employee_id=att["employee_id"],
            )
        except Exception as err:  # noqa: BLE001
            log_error("Failed to notify for auto-cutoff attendance", attendance_id=att["id"], error=str(err))

    return len(rows)


async def run_auto_cutoff_sweep() -> None:
    try:
        visits_closed = await _cutoff_open_visits()
        attendance_closed = await _cutoff_open_attendance()
        if visits_closed > 0 or attendance_closed > 0:
            log_info("Auto-cutoff sweep closed forgotten logouts", visits_closed=visits_closed, attendance_closed=attendance_closed)
    except Exception as err:  # noqa: BLE001
        log_error("Auto-cutoff sweep failed", error=str(err))
