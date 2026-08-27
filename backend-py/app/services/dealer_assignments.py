"""
dealer_assignments.py — ports dealerAssignments.js exactly. Shared by
assignments/navigation/visits routers. Both functions are defensive
(try/except, log-and-continue, NEVER raise) — a rep's check-in or day-logout
must succeed regardless of whether an assignment happens to exist or this
side effect happens to fail.
"""
from app.core.logging_config import log_error
from app.db import pool
from app.services.manager_notifications import create_manager_notification
from app.utils.business_day import business_date_expr


async def mark_assignment_visited(employee_id: int, dealer_id: int) -> None:
    try:
        row = await pool.fetchrow(
            f"""
            UPDATE dealer_assignments
            SET status = 'completed', updated_at = NOW()
            WHERE employee_id = $1 AND dealer_id = $2
              AND assignment_date = {business_date_expr('NOW()')}
              AND status != 'completed'
            RETURNING id
            """,
            employee_id, dealer_id,
        )
        assignment_id = row["id"] if row is not None else None
        if assignment_id is not None:
            await pool.execute(
                """
                UPDATE dealer_navigations
                SET status = 'completed', ended_at = NOW()
                WHERE id = (
                    SELECT id FROM dealer_navigations
                    WHERE assignment_id = $1 AND status IN ('navigating', 'arrived')
                    ORDER BY started_at DESC
                    LIMIT 1
                )
                """,
                assignment_id,
            )
    except Exception as err:  # noqa: BLE001
        log_error("Failed to mark dealer assignment visited", error=str(err), employee_id=employee_id, dealer_id=dealer_id)


async def notify_unvisited_assignments(employee_id: int) -> None:
    try:
        rows = await pool.fetch(
            f"""
            SELECT d.name AS dealer_name
            FROM dealer_assignments da
            JOIN dealers d ON d.id = da.dealer_id
            WHERE da.employee_id = $1
              AND da.assignment_date = {business_date_expr('NOW()')}
              AND da.status NOT IN ('completed', 'cancelled')
            ORDER BY da.sequence_order ASC
            """,
            employee_id,
        )
        if not rows:
            return

        employee_row = await pool.fetchrow("SELECT username FROM employees WHERE id = $1", employee_id)
        username = employee_row["username"] if employee_row is not None else f"Employee #{employee_id}"
        dealer_names = [r["dealer_name"] for r in rows]

        if len(dealer_names) == 1:
            body = f"{username} ended the day without visiting {dealer_names[0]}."
        else:
            body = (
                f"{username} ended the day without visiting {len(dealer_names)} assigned dealers: "
                f"{', '.join(dealer_names)}."
            )

        await create_manager_notification(
            type="unvisited_assignments",
            title="Assigned dealer(s) not visited today",
            body=body,
            severity="warning",
            employee_id=employee_id,
        )
    except Exception as err:  # noqa: BLE001
        log_error("Failed to notify unvisited assignments", error=str(err), employee_id=employee_id)
