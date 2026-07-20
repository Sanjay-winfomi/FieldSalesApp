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

const authRouter       = require('./routes/auth.routes');
const attendanceRouter = require('./routes/attendance.routes');
const visitsRouter     = require('./routes/visits.routes');
const dealersRouter    = require('./routes/dealers.routes');
const dashboardRouter  = require('./routes/dashboard.routes');

const { requireAuth, requireRole } = require('./middleware/auth.middleware');

const app  = express();
const PORT = parseInt(process.env.PORT || '3001');

// ── Security Middleware ────────────────────────────────────────────────────────
app.use(helmet());

// Dynamic CORS configurations
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:19006', 'http://localhost:8081'];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
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

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── Public routes ─────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter);

// ── Protected routes (all require JWT) ───────────────────────────────────────
app.use('/api/attendance', requireAuth, attendanceRouter);
app.use('/api/visits',     requireAuth, visitsRouter);
app.use('/api/dealers',    requireAuth, dealersRouter);

// ── Manager-only routes ───────────────────────────────────────────────────────
app.use('/api/dashboard',  requireAuth, requireRole('manager'), dashboardRouter);

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 FieldTrack backend running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}\n`);
});

module.exports = app;
