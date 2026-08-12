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
// working immediately, not hours later. Also re-checks role for the same
// reason: req.employee.role otherwise came straight from the JWT payload
// signed at login, so a manager demoted to rep (or promoted) would keep
// their OLD role's access for up to JWT_EXPIRES_IN — the exact class of
// stale-privilege bug the is_active check exists to prevent. Cached briefly
// per-token to avoid a DB round trip on every single request.
const employeeStateCache = new Map();
const ACTIVE_STATUS_CACHE_TTL_MS = 30 * 1000;

async function getEmployeeState(employeeId) {
  const cached = employeeStateCache.get(employeeId);
  if (cached && Date.now() - cached.time < ACTIVE_STATUS_CACHE_TTL_MS) {
    return cached;
  }
  const result = await pool.query('SELECT is_active, role FROM employees WHERE id = $1', [employeeId]);
  const state = {
    isActive: result.rows.length > 0 && result.rows[0].is_active === true,
    role: result.rows[0]?.role ?? null,
    time: Date.now(),
  };
  employeeStateCache.set(employeeId, state);
  return state;
}

// Entries are only ever overwritten on the next request from the same
// employee, never removed — sweep out expired ones periodically so the map
// doesn't keep an entry forever for an employee who never logs in again
// (e.g. one who left the company). unref() so this timer never keeps the
// process alive on its own (relevant for tests and clean shutdowns).
const sweepInterval = setInterval(() => {
  const now = Date.now();
  for (const [employeeId, entry] of employeeStateCache) {
    if (now - entry.time >= ACTIVE_STATUS_CACHE_TTL_MS) {
      employeeStateCache.delete(employeeId);
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

    const state = await getEmployeeState(payload.sub);
    if (!state.isActive) {
      return res.status(401).json({ error: 'Account is deactivated' });
    }

    req.employee = {
      id:       payload.sub,
      // Fresh from the DB, not the JWT payload — a role change must take
      // effect within ACTIVE_STATUS_CACHE_TTL_MS, not wait for the token
      // to expire and be refreshed.
      role:     state.role ?? payload.role,
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
