/**
 * index.js — FieldTrack Express backend entry point
 *
 * Stages covered:
 *   Stage 3  — Database schema (migrate.js / schema.sql / seed.js)
 *   Stage 4  — JWT authentication (auth.routes.js + auth.middleware.js)
 *   Stage 5  — Core attendance & visit API + Haversine distance calculation
 *   Stage 10 — Dashboard API (manager-only)
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const logger = require('./utils/logger');
const pool   = require('./db/pool');

// Safety net for errors outside the request/response lifecycle (a rejected
// promise nobody awaited, a throw inside a bare setInterval callback) — these
// don't reach Express's error-handling middleware at all. Without this they
// silently vanish (unhandledRejection) or crash the process with a raw stack
// trace and no record of it in the logs (uncaughtException).
process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.error('Unhandled promise rejection', { error: error.message, stack: error.stack });
});
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception — exiting', { error: error.message, stack: error.stack });
  // The process is in an unknown state after this — exit so the host's
  // process manager (Render, pm2, systemd, ...) restarts it clean, rather
  // than keep serving requests against potentially corrupted in-memory state.
  process.exit(1);
});

const authRouter       = require('./routes/auth.routes');
const attendanceRouter = require('./routes/attendance.routes');
const visitsRouter     = require('./routes/visits.routes');
const dealersRouter    = require('./routes/dealers.routes');
const dashboardRouter  = require('./routes/dashboard.routes');
const employeesRouter  = require('./routes/employees.routes');
const reportsRouter    = require('./routes/reports.routes');
const geocodeRouter    = require('./routes/geocode.routes');
const notesRouter      = require('./routes/notes.routes');
const remindersRouter  = require('./routes/reminders.routes');
const notificationsRouter = require('./routes/notifications.routes');
const syncFailuresRouter = require('./routes/syncFailures.routes');
const assignmentsRouter  = require('./routes/assignments.routes');
const navigationRouter   = require('./routes/navigation.routes');

const { requireAuth, requireRole } = require('./middleware/auth.middleware');

// Fail fast at boot rather than let the first login attempt throw a confusing
// 500 from jwt.sign — and refuse to start in production with the placeholder
// secret from .env.example, which would make every issued token forgeable.
const PLACEHOLDER_JWT_SECRET = 'fieldtrack_jwt_secret_change_in_production_2026';
if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set — refusing to start without it.');
}
if (process.env.NODE_ENV === 'production' && process.env.JWT_SECRET === PLACEHOLDER_JWT_SECRET) {
  throw new Error('JWT_SECRET is still the .env.example placeholder — set a real secret before running in production.');
}

const app  = express();
const PORT = parseInt(process.env.PORT || '3001');

// Trust the first hop's X-Forwarded-* headers (reverse proxy / load balancer),
// required in production for express-rate-limit and req.ip to see the real
// client IP instead of the proxy's — without this, every user shares one
// rate-limit bucket (the proxy's IP) and gets locked out together.
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', parseInt(process.env.TRUST_PROXY_HOPS || '1'));
}

// ── Security Middleware ────────────────────────────────────────────────────────
app.use(helmet());

// Dynamic CORS configuration.
// This is a local-dev tool, never exposed to the public internet, and the
// dev machine's LAN IP changes on every DHCP renewal/Wi-Fi reconnect — so
// instead of hardcoding IPs that go stale, allow any localhost or private
// LAN origin (RFC 1918) on any port and any URL scheme (Expo Go's own
// networking layer can send an `exp://` origin, not just http/https, so we
// parse out just the hostname rather than pattern-matching the scheme too).
// ALLOWED_ORIGINS can still be set to an explicit comma-separated list to
// lock this down — and MUST be set in production (enforced below), since
// the private-LAN fallback would otherwise reject every real origin anyway
// (a safe failure mode, but one that shouldn't rely on being forgotten).
if (process.env.NODE_ENV === 'production' && !process.env.ALLOWED_ORIGINS) {
  throw new Error(
    'ALLOWED_ORIGINS must be set in production (comma-separated list of allowed origins) — refusing to start with the permissive local-dev CORS fallback.'
  );
}

const explicitAllowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : null;

const PRIVATE_HOSTNAME_PATTERN = /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)$/;

function isLocalOrigin(origin) {
  try {
    return PRIVATE_HOSTNAME_PATTERN.test(new URL(origin).hostname);
  } catch {
    return false; // Not a parseable URL — reject rather than risk a bypass.
  }
}

// Tagged so the global error handler can return 403 instead of a generic 500
// — a rejected CORS origin isn't a server fault, and 500s obscure the real
// cause in logs/monitoring.
function makeCorsError() {
  const err = new Error('Not allowed by CORS');
  err.isCorsError = true;
  return err;
}

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (explicitAllowedOrigins) {
      if (explicitAllowedOrigins.indexOf(origin) !== -1) return callback(null, true);
      logger.warn(`CORS rejected origin (not in ALLOWED_ORIGINS): "${origin}"`);
      return callback(makeCorsError());
    }
    if (isLocalOrigin(origin)) return callback(null, true);
    logger.warn(`CORS rejected origin (not a local/private-LAN origin): "${origin}"`);
    return callback(makeCorsError());
  },
  credentials: true,
}));

app.use(express.json());

// Rate limit generic API requests
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 mins
  max: 200, // limit each IP to 200 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

// Strict rate limit for login attempts
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // limit to 20 login attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again in 15 minutes.' }
});

app.use('/api/', apiLimiter);
app.use('/api/auth/login', loginLimiter);
// A leaked refresh token is valid for 7 days — without this it could be
// replayed/brute-forced at the generic 200/15min rate instead of the same
// strict limit login attempts get.
app.use('/api/auth/refresh', loginLimiter);
// Same strict limit — otherwise it's an unthrottled oracle for brute-forcing
// an employee's phone number to hijack their account.
app.use('/api/auth/forgot-password', loginLimiter);

// ── Health check ──────────────────────────────────────────────────────────────
// Cheap liveness check — deliberately does no I/O, so an uptime monitor
// polling this frequently never adds load or false-positives on a slow DB.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Deeper readiness check — actually round-trips the database, so an uptime
// monitor can distinguish "process is up" from "the app can actually serve
// requests" (e.g. DB connection pool exhausted, Postgres unreachable).
app.get('/health/deep', async (req, res) => {
  const checks = { database: 'ok' };
  let healthy = true;

  try {
    await pool.query('SELECT 1');
  } catch (err) {
    healthy = false;
    checks.database = 'error';
    logger.error('Deep health check: database unreachable', { error: err.message });
  }

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    time: new Date().toISOString(),
    checks,
  });
});

// ── Public routes ─────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter);

// ── Protected routes (all require JWT) ───────────────────────────────────────
app.use('/api/attendance', requireAuth, attendanceRouter);
app.use('/api/visits',     requireAuth, visitsRouter);
app.use('/api/dealers',    requireAuth, dealersRouter);
app.use('/api/geocode',    requireAuth, geocodeRouter);
app.use('/api/notes',      requireAuth, notesRouter);
app.use('/api/reminders',  requireAuth, remindersRouter);
// Any authenticated employee (rep or manager) — a rep's own device is what
// reports its own permanently-failed sync attempts here.
app.use('/api/sync-failures', requireAuth, syncFailuresRouter);
// Mixed access, same as dealers/reminders above — role checks live at the
// individual route level (manager-only assignment editing, rep-only "today").
app.use('/api/assignments', requireAuth, assignmentsRouter);
app.use('/api/navigation',  requireAuth, navigationRouter);

// Exposes the actual configured login tolerance radius so the UI never
// has to hardcode a value that could drift from what .env really says.
app.get('/api/config', requireAuth, (req, res) => {
  res.json({ loginRadiusMeters: parseInt(process.env.LOGIN_RADIUS_METERS || '100') });
});

// ── Manager-only routes ───────────────────────────────────────────────────────
app.use('/api/dashboard',  requireAuth, requireRole('manager'), dashboardRouter);
app.use('/api/employees',  requireAuth, requireRole('manager'), employeesRouter);
app.use('/api/reports',    requireAuth, requireRole('manager'), reportsRouter);
app.use('/api/notifications', requireAuth, requireRole('manager'), notificationsRouter);

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.isCorsError) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`FieldTrack backend running on http://localhost:${PORT}`, {
    health: `http://localhost:${PORT}/health`,
    environment: process.env.NODE_ENV || 'development',
  });
});

module.exports = app;
