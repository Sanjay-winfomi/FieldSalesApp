"""absence_check.py — ports absenceCheck.js exactly (same lookback window,
same 11pm-IST-per-business-date threshold, same dedup logic via the
day_absent partial unique index)."""
from app.core.logging_config import log_error, log_info
from app.db import pool
from app.services.manager_notifications import create_manager_notification
from app.utils.business_day import business_date_expr

LOOKBACK_DAYS = 2  # plus today = 3 business dates checked each run


async def _flag_absent_reps() -> int:
    rows = await pool.fetch(
        f"""
        WITH business_dates AS (
           SELECT d::date AS business_date
           FROM generate_series(
             {business_date_expr('NOW()')} - INTERVAL '{LOOKBACK_DAYS} days',
             {business_date_expr('NOW()')},
             INTERVAL '1 day'
           ) d
         ),
         eligible_dates AS (
           SELECT business_date FROM business_dates
           WHERE NOW() >= (business_date + INTERVAL '23 hours') AT TIME ZONE 'Asia/Kolkata'
         )
         SELECT e.id AS employee_id, e.username, ed.business_date
         FROM eligible_dates ed
         CROSS JOIN employees e
         WHERE e.role = 'rep' AND e.is_active = true
           AND NOT EXISTS (
             SELECT 1 FROM attendance a WHERE a.employee_id = e.id AND a.business_date = ed.business_date
           )
           AND NOT EXISTS (
             SELECT 1 FROM manager_notifications n
             WHERE n.employee_id = e.id AND n.type = 'day_absent'
               AND {business_date_expr('n.created_at')} = ed.business_date
           )
        """
    )

    for row in rows:
        try:
            date_label = row["business_date"].strftime("%d %b %Y")
            await create_manager_notification(
                type="day_absent",
                title="Representative did not log in",
                body=f"{row['username']} did not log in on {date_label} — likely absent, follow up if unplanned.",
                severity="danger",
                employee_id=row["employee_id"],
                # asyncpg binds a DATE column parameter from a native
                # datetime.date object, not a string (unlike node-pg, which
                # accepts a 'YYYY-MM-DD' string and casts it) — passing
                # .isoformat() here raised "'str' object has no attribute
                # 'toordinal'" on every insert.
                business_date=row["business_date"],
            )
        except Exception as err:  # noqa: BLE001
            log_error("Failed to notify for absent rep", employee_id=row["employee_id"], error=str(err))

    return len(rows)


async def run_absence_check_sweep() -> None:
    try:
        flagged = await _flag_absent_reps()
        if flagged > 0:
            log_info("Absence check flagged reps who did not log in", flagged=flagged)
    except Exception as err:  # noqa: BLE001
        log_error("Absence check sweep failed", error=str(err))
