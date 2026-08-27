"""
manager_notifications.py — ports managerNotifications.js exactly. Writes to
manager_notifications (there is no push-notification infra in this app;
managers are web-dashboard-only, so "notifying" means inserting a row for
the bell/unread-count to pick up on its next poll).
"""
from typing import Optional

from app.core.logging_config import log_error
from app.db import pool


async def create_manager_notification(
    type: str,
    title: str,
    body: str,
    severity: str = "info",
    employee_id: Optional[int] = None,
    dealer_id: Optional[int] = None,
    visit_id: Optional[int] = None,
    followup_request_id: Optional[int] = None,
    business_date: Optional[str] = None,
) -> None:
    try:
        await pool.execute(
            """
            INSERT INTO manager_notifications
                (type, title, body, severity, employee_id, dealer_id, visit_id, followup_request_id, business_date)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (employee_id, business_date) WHERE type = 'day_absent' DO NOTHING
            """,
            type, title, body, severity, employee_id, dealer_id, visit_id, followup_request_id, business_date,
        )
    except Exception as err:  # noqa: BLE001 — a notification write must never fail the triggering request
        log_error("Failed to create manager notification", error=str(err), type=type)
