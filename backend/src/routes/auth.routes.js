/**
 * auth.routes.js — Stage 4: Authentication endpoints
 *
 * POST /api/auth/login   — verify credentials, return JWT + refresh token
 * POST /api/auth/refresh — exchange a refresh token for a new access token
 */
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const pool    = require('../db/pool');

const router = express.Router();

function signAccessToken(employee) {
  return jwt.sign(
    { sub: employee.id, role: employee.role, username: employee.username },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  );
}

function signRefreshToken(employee) {
  return jwt.sign(
    { sub: employee.id, type: 'refresh' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  try {
    const result = await pool.query(
      'SELECT id, name, username, password_hash, role, region FROM employees WHERE username = $1',
      [username]
    );

    const employee = result.rows[0];

    if (!employee) {
      // Use same error message as wrong password to avoid username enumeration
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const passwordValid = await bcrypt.compare(password, employee.password_hash);
    if (!passwordValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const accessToken  = signAccessToken(employee);
    const refreshToken = signRefreshToken(employee);

    return res.json({
      accessToken,
      refreshToken,
      employee: {
        id:       employee.id,
        name:     employee.name,
        username: employee.username,
        role:     employee.role,
        region:   employee.region,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({ error: 'refreshToken is required' });
  }

  try {
    const payload = jwt.verify(refreshToken, process.env.JWT_SECRET);

    if (payload.type !== 'refresh') {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    // Re-fetch employee to ensure they still exist / aren't deactivated
    const result = await pool.query(
      'SELECT id, name, username, role, region FROM employees WHERE id = $1',
      [payload.sub]
    );

    const employee = result.rows[0];
    if (!employee) {
      return res.status(401).json({ error: 'Employee not found' });
    }

    const accessToken = signAccessToken(employee);
    return res.json({ accessToken });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Refresh token expired — please log in again' });
    }
    return res.status(401).json({ error: 'Invalid refresh token' });
  }
});

module.exports = router;
