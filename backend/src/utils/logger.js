/**
 * logger.js — structured logging (Winston) replacing bare console.log/error.
 *
 * - Console transport: human-readable, colorized, for local dev.
 * - File transports: JSON, daily-rotated, kept in backend/logs/ — one file
 *   for everything at LOG_LEVEL and above, one error-only file for fast
 *   incident triage without grepping through info-level noise.
 * LOG_LEVEL defaults to 'debug' in development and 'info' in production.
 */
const path = require('path');
const winston = require('winston');
require('winston-daily-rotate-file');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', '..', 'logs');
const LOG_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

const jsonFileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `[${timestamp}] ${level}: ${message}${extra}`;
  })
);

const transports = [
  new winston.transports.Console({ format: consoleFormat }),
  new winston.transports.DailyRotateFile({
    dirname: LOG_DIR,
    filename: 'combined-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxFiles: '14d',
    format: jsonFileFormat,
  }),
  new winston.transports.DailyRotateFile({
    dirname: LOG_DIR,
    filename: 'error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxFiles: '30d',
    level: 'error',
    format: jsonFileFormat,
  }),
];

// Tests set NODE_ENV=test — file transports would otherwise create a real
// logs/ directory and daily-rotate timers on every test run.
const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: jsonFileFormat,
  transports: process.env.NODE_ENV === 'test' ? [] : transports,
  silent: process.env.NODE_ENV === 'test',
});

module.exports = logger;
