/**
 * auth.middleware.js
 *
 * requireAuth  — verifies JWT, attaches req.employee = { id, role, username }
 * requireRole  — factory for role-based access control
 */
const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const token = authHeader.slice(7); // strip "Bearer "
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
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
