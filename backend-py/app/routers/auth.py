"""auth.py — ports auth.routes.js exactly (public, but rate-limited by
loginLimiter on all three routes — see main.py's slowapi wiring)."""
import re

import bcrypt
import jwt as pyjwt
from fastapi import APIRouter, Request, Response
from pydantic import BaseModel
from starlette.responses import JSONResponse

from app.core import security
from app.core.logging_config import log_error
from app.core.rate_limit import LOGIN_LIMIT, limiter
from app.db import pool

router = APIRouter()


class LoginBody(BaseModel):
    username: str | None = None
    password: str | None = None


class RefreshBody(BaseModel):
    refreshToken: str | None = None


class ForgotPasswordBody(BaseModel):
    username: str | None = None
    phone: str | None = None
    new_password: str | None = None


@router.post("/login")
@limiter.limit(LOGIN_LIMIT)
async def login(request: Request, body: LoginBody, response: Response):
    if not body.username or not body.password:
        return JSONResponse({"error": "username and password are required"}, status_code=400)

    try:
        row = await pool.fetchrow(
            "SELECT id, name, username, password_hash, role, region, is_active FROM employees WHERE LOWER(username) = LOWER($1)",
            body.username,
        )

        if row is None or not row["is_active"]:
            return JSONResponse({"error": "Username not found"}, status_code=401)

        password_valid = bcrypt.checkpw(body.password.encode("utf-8"), row["password_hash"].encode("utf-8"))
        if not password_valid:
            return JSONResponse({"error": "Incorrect password"}, status_code=401)

        access_token = security.sign_access_token(row["id"], row["role"], row["username"])
        refresh_token = security.sign_refresh_token(row["id"])

        return {
            "accessToken": access_token,
            "refreshToken": refresh_token,
            "employee": {
                "id": row["id"],
                "name": row["name"],
                "username": row["username"],
                "role": row["role"],
                "region": row["region"],
            },
        }
    except Exception as err:  # noqa: BLE001
        log_error("Login error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)


@router.post("/refresh")
@limiter.limit(LOGIN_LIMIT)
async def refresh(request: Request, body: RefreshBody, response: Response):
    if not body.refreshToken:
        return JSONResponse({"error": "refreshToken is required"}, status_code=400)

    try:
        payload = security.decode_token(body.refreshToken)
    except pyjwt.ExpiredSignatureError:
        return JSONResponse({"error": "Refresh token expired — please log in again"}, status_code=401)
    except pyjwt.InvalidTokenError:
        return JSONResponse({"error": "Invalid refresh token"}, status_code=401)

    if payload.get("type") != "refresh":
        return JSONResponse({"error": "Invalid refresh token"}, status_code=401)

    row = await pool.fetchrow(
        "SELECT id, name, username, role, region, is_active FROM employees WHERE id = $1", payload.get("sub")
    )
    if row is None or not row["is_active"]:
        return JSONResponse({"error": "Employee not found"}, status_code=401)

    access_token = security.sign_access_token(row["id"], row["role"], row["username"])
    return {"accessToken": access_token}


def _normalize_phone(phone: str | None) -> str:
    digits = re.sub(r"\D", "", phone or "")
    return digits[-10:]


@router.post("/forgot-password")
@limiter.limit(LOGIN_LIMIT)
async def forgot_password(request: Request, body: ForgotPasswordBody, response: Response):
    if not body.username or not body.phone or not body.new_password:
        return JSONResponse({"error": "username, phone, and new_password are required"}, status_code=400)
    if len(body.new_password) < 6:
        return JSONResponse({"error": "new_password must be at least 6 characters"}, status_code=400)

    try:
        row = await pool.fetchrow(
            "SELECT id, phone, is_active FROM employees WHERE LOWER(username) = LOWER($1)", body.username
        )
        if row is None or not row["is_active"]:
            return JSONResponse({"error": "Username not found"}, status_code=401)

        normalized_input = _normalize_phone(body.phone)
        normalized_on_file = _normalize_phone(row["phone"])
        if not normalized_on_file or normalized_input != normalized_on_file:
            return JSONResponse({"error": "Phone number does not match our records"}, status_code=401)

        password_hash = bcrypt.hashpw(body.new_password.encode("utf-8"), bcrypt.gensalt(10)).decode("utf-8")
        await pool.execute("UPDATE employees SET password_hash = $1 WHERE id = $2", password_hash, row["id"])

        return {"success": True}
    except Exception as err:  # noqa: BLE001
        log_error("POST /api/auth/forgot-password error", error=str(err))
        return JSONResponse({"error": "Internal server error"}, status_code=500)
