"""
logging_config.py — structured logging, replacing Winston + winston-daily-rotate-file.

- Console handler: human-readable, for local dev.
- File handlers: JSON, rotated at midnight, kept in LOG_DIR — one file for
  everything at LOG_LEVEL and above (combined-YYYY-MM-DD.log, 14-day
  retention), one error-only file (error-YYYY-MM-DD.log, 30-day retention),
  matching logger.js's two-file split exactly.
- Tests run with NODE_ENV=test: no file transports, no console output —
  mirrors logger.js's `silent` flag so a test run never creates a real logs/
  directory.
"""
import json
import logging
import os
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path

from app.core import config


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        # time.strftime (what Formatter.formatTime uses under the hood) has
        # no '%f' microseconds directive — that's a datetime.strftime-only
        # feature — so build the millisecond-precision, 'Z'-suffixed
        # timestamp by hand instead of passing '%f' through formatTime.
        base = self.formatTime(record, "%Y-%m-%dT%H:%M:%S")
        payload = {
            "level": record.levelname.lower(),
            "message": record.getMessage(),
            "timestamp": f"{base}.{int(record.msecs):03d}Z",
        }
        extra = getattr(record, "extra_fields", None)
        if extra:
            payload.update(extra)
        if record.exc_info:
            payload["stack"] = self.formatException(record.exc_info)
        return json.dumps(payload)


class ConsoleFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        ts = self.formatTime(record, "%H:%M:%S")
        extra = getattr(record, "extra_fields", None)
        suffix = f" {json.dumps(extra)}" if extra else ""
        return f"[{ts}] {record.levelname.lower()}: {record.getMessage()}{suffix}"


_LEVEL_MAP = {
    "error": logging.ERROR,
    "warn": logging.WARNING,
    "warning": logging.WARNING,
    "info": logging.INFO,
    "debug": logging.DEBUG,
}


def _build_logger() -> logging.Logger:
    logger = logging.getLogger("fieldtrack")
    logger.setLevel(_LEVEL_MAP.get(config.LOG_LEVEL, logging.DEBUG))
    logger.propagate = False
    logger.handlers.clear()

    if config.IS_TEST:
        logger.addHandler(logging.NullHandler())
        return logger

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(ConsoleFormatter())
    logger.addHandler(console_handler)

    log_dir = Path(config.LOG_DIR)
    log_dir.mkdir(parents=True, exist_ok=True)

    combined_handler = TimedRotatingFileHandler(
        filename=str(log_dir / "combined.log"),
        when="midnight",
        backupCount=14,
        encoding="utf-8",
    )
    combined_handler.suffix = "%Y-%m-%d"
    combined_handler.setFormatter(JsonFormatter())
    logger.addHandler(combined_handler)

    error_handler = TimedRotatingFileHandler(
        filename=str(log_dir / "error.log"),
        when="midnight",
        backupCount=30,
        encoding="utf-8",
    )
    error_handler.suffix = "%Y-%m-%d"
    error_handler.setLevel(logging.ERROR)
    error_handler.setFormatter(JsonFormatter())
    logger.addHandler(error_handler)

    return logger


logger = _build_logger()


def log_error(message: str, **extra_fields) -> None:
    logger.error(message, extra={"extra_fields": extra_fields})


def log_warn(message: str, **extra_fields) -> None:
    logger.warning(message, extra={"extra_fields": extra_fields})


def log_info(message: str, **extra_fields) -> None:
    logger.info(message, extra={"extra_fields": extra_fields})
