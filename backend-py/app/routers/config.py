"""config.py — ports index.js's inline GET /api/config route exactly."""
from fastapi import APIRouter, Depends

from app.core.config import LOGIN_RADIUS_METERS
from app.core.security import get_current_employee

router = APIRouter(dependencies=[Depends(get_current_employee)])


@router.get("")
async def get_config():
    return {"loginRadiusMeters": LOGIN_RADIUS_METERS}
