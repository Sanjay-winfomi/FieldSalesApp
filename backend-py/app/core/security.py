"""
security.py — JWT issuing/verification + the requireAuth/requireRole
equivalents, porting auth.middleware.js and auth.routes.js's token helpers
exactly (same claims, same algorithm, same 30s employee-state cache
semantics — see the module docstring on `_EmployeeStateCache` below).
"""
import time
from dataclasses import dataclass
from typing import Optional

import jwt
from fastapi import Depends, HTTPException, Request, status

from app.core import config
from app.db import pool
from app.utils.duration import parse_duration_seconds

ALGORITHM = "HS256"


@dataclass
class Employee:
    id: int
    role: str
    username: str


def sign_access_token(employee_id: int, role: str, username: str) -> str:
    now = int(time.time())
    payload = {
        "sub": employee_id,
        "role": role,
        "username": username,
        "iat": now,
        "exp": now + parse_duration_seconds(config.JWT_EXPIRES_IN),
    }
    return jwt.encode(payload, config.JWT_SECRET, algorithm=ALGORITHM)


def sign_refresh_token(employee_id: int) -> str:
    now = int(time.time())
    payload = {
        "sub": employee_id,
        "type": "refresh",
        "iat": now,
        "exp": now + parse_duration_seconds(config.JWT_REFRESH_EXPIRES_IN),
    }
    return jwt.encode(payload, config.JWT_SECRET, algorithm=ALGORITHM)


def decode_token(token: str) -> dict:
    """Raises jwt.ExpiredSignatureError / jwt.InvalidTokenError, mirrored by
    callers into the same 401 messages auth.middleware.js / auth.routes.js use.

    verify_sub=False: Node's `jsonwebtoken` signs `sub` as a raw number
    (`employee.id`), not a string, and never validates its type on decode.
    PyJWT >=2.10 enforces RFC 7519's "sub SHOULD be a string" as a hard
    decode-time check by default (raises InvalidSubjectError otherwise) —
    without disabling it, PyJWT rejects every token from both backends
    (including its own), which is a total-auth-outage bug, not a subtle
    difference. Disabling this check is required for parity, not optional.
    """
    return jwt.decode(token, config.JWT_SECRET, algorithms=[ALGORITHM], options={"verify_sub": False})


# ---------------------------------------------------------------------------
# 30-second TTL employee-state cache — ports auth.middleware.js's
# employeeStateCache exactly:
#   - keyed by employee id (JWT `sub`)
#   - a cache HIT (age < TTL) returns the cached state with no DB query
#   - a cache MISS re-fetches is_active/role and unconditionally overwrites
#     the entry, even when the employee no longer exists (isActive=False gets
#     cached too, so a deleted employee's stale token still fast-paths to a
#     401 for the next 30s without a DB hit)
#   - no proactive invalidation: deactivating/promoting an employee elsewhere
#     does NOT clear their entry; it only naturally expires within the TTL
#   - a periodic sweep purges expired entries so the dict doesn't grow
#     unbounded for employees who never make another request; this is a
#     memory-leak guard only, NOT part of the invalidation logic itself
# ---------------------------------------------------------------------------
ACTIVE_STATUS_CACHE_TTL_SECONDS = 30


class _EmployeeState:
    __slots__ = ("is_active", "role", "time")

    def __init__(self, is_active: bool, role: Optional[str]):
        self.is_active = is_active
        self.role = role
        self.time = time.monotonic()


_employee_state_cache: dict[int, _EmployeeState] = {}


async def get_employee_state(employee_id: int) -> _EmployeeState:
    cached = _employee_state_cache.get(employee_id)
    if cached is not None and (time.monotonic() - cached.time) < ACTIVE_STATUS_CACHE_TTL_SECONDS:
        return cached

    row = await pool.fetchrow("SELECT is_active, role FROM employees WHERE id = $1", employee_id)
    state = _EmployeeState(
        is_active=bool(row["is_active"]) if row is not None else False,
        role=row["role"] if row is not None else None,
    )
    _employee_state_cache[employee_id] = state
    return state


def sweep_expired_employee_state_cache() -> None:
    now = time.monotonic()
    expired = [
        employee_id
        for employee_id, entry in _employee_state_cache.items()
        if now - entry.time >= ACTIVE_STATUS_CACHE_TTL_SECONDS
    ]
    for employee_id in expired:
        del _employee_state_cache[employee_id]


# ---------------------------------------------------------------------------
# FastAPI dependencies — equivalents of requireAuth / requireRole
# ---------------------------------------------------------------------------
async def get_current_employee(request: Request) -> Employee:
    auth_header = request.headers.get("authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or malformed Authorization header")

    token = auth_header[7:]
    try:
        payload = decode_token(token)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

    employee_id = payload.get("sub")
    state = await get_employee_state(employee_id)
    if not state.is_active:
        raise HTTPException(status_code=401, detail="Account is deactivated")

    return Employee(
        id=employee_id,
        role=state.role if state.role is not None else payload.get("role"),
        username=payload.get("username"),
    )


def require_role(role: str):
    async def _dependency(employee: Employee = Depends(get_current_employee)) -> Employee:
        if employee.role != role:
            raise HTTPException(status_code=403, detail=f"Requires role: {role}")
        return employee

    return _dependency


require_manager = require_role("manager")
require_rep = require_role("rep")
