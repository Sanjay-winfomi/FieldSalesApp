/**
 * auth.middleware.js
 *
 * requireAuth  — verifies JWT, attaches req.employee = { id, role, username }
 * requireRole  — factory for role-based access control
 */
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

// A deactivated employee's still-valid access token (up to JWT_EXPIRES_IN,
// default 8h) would otherwise keep working until it naturally expires — a
// manager deactivating a terminated/compromised account expects it to stop
// working immediately, not hours later. Cached briefly per-token to avoid a
// DB round trip on every single request.
const activeStatusCache = new Map();
const ACTIVE_STATUS_CACHE_TTL_MS = 30 * 1000;

async function isEmployeeActive(employeeId) {
  const cached = activeStatusCache.get(employeeId);
  if (cached && Date.now() - cached.time < ACTIVE_STATUS_CACHE_TTL_MS) {
    return cached.isActive;
  }
  const result = await pool.query('SELECT is_active FROM employees WHERE id = $1', [employeeId]);
  const isActive = result.rows.length > 0 && result.rows[0].is_active === true;
  activeStatusCache.set(employeeId, { isActive, time: Date.now() });
  return isActive;
}

// Entries are only ever overwritten on the next request from the same
// employee, never removed — sweep out expired ones periodically so the map
// doesn't keep an entry forever for an employee who never logs in again
// (e.g. one who left the company). unref() so this timer never keeps the
// process alive on its own (relevant for tests and clean shutdowns).
const sweepInterval = setInterval(() => {
  const now = Date.now();
  for (const [employeeId, entry] of activeStatusCache) {
    if (now - entry.time >= ACTIVE_STATUS_CACHE_TTL_MS) {
      activeStatusCache.delete(employeeId);
    }
  }
}, ACTIVE_STATUS_CACHE_TTL_MS);
sweepInterval.unref();

async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const token = authHeader.slice(7); // strip "Bearer "
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    const active = await isEmployeeActive(payload.sub);
    if (!active) {
      return res.status(401).json({ error: 'Account is deactivated' });
    }

    req.employee = {
      id:       payload.sub,
      role:     payload.role,
      username: payload.username,
    };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.employee) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (req.employee.role !== role) {
      return res.status(403).json({ error: `Requires role: ${role}` });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
