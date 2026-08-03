/**
 * auth.routes.js — Stage 4: Authentication endpoints
 *
 * POST /api/auth/login            — verify credentials, return JWT + refresh token
 * POST /api/auth/refresh          — exchange a refresh token for a new access token
 * POST /api/auth/forgot-password  — self-service reset: username + registered
 *                                    phone number in place of a current password
 */
const express = require('express');
const logger = require('../utils/logger');
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
    // Case-insensitive — mobile keyboards routinely auto-capitalize the first
    // letter of a text field regardless of the app's autoCapitalize hint, so
    // treating "Tamil.kumar" and "tamil.kumar" as different accounts is a
    // guaranteed, recurring source of "wrong password" confusion.
    const result = await pool.query(
      'SELECT id, name, username, password_hash, role, region, is_active FROM employees WHERE LOWER(username) = LOWER($1)',
      [username]
    );

    const employee = result.rows[0];

    if (!employee || !employee.is_active) {
      // Distinct from a wrong-password message on purpose — this is an
      // internal tool with a small, known set of accounts, so the usual
      // username-enumeration concern doesn't apply, and a specific message
      // helps reps catch their own typos instead of assuming the server's down.
      return res.status(401).json({ error: 'Username not found' });
    }

    const passwordValid = await bcrypt.compare(password, employee.password_hash);
    if (!passwordValid) {
      return res.status(401).json({ error: 'Incorrect password' });
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
    logger.error('Login error', { error: err.message, stack: err.stack });
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
      'SELECT id, name, username, role, region, is_active FROM employees WHERE id = $1',
      [payload.sub]
    );

    const employee = result.rows[0];
    if (!employee || !employee.is_active) {
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

// Digits only, last 10 — tolerates a manager/rep typing a leading country
// code (e.g. +91) or dashes/spaces that the stored value may or may not have.
function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.slice(-10);
}

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  const { username, phone, new_password: newPassword } = req.body;

  if (!username || !phone || !newPassword) {
    return res.status(400).json({ error: 'username, phone, and new_password are required' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'new_password must be at least 6 characters' });
  }

  try {
    const result = await pool.query(
      'SELECT id, phone, is_active FROM employees WHERE LOWER(username) = LOWER($1)',
      [username]
    );

    const employee = result.rows[0];
    if (!employee || !employee.is_active) {
      // Same reasoning as /login: an internal tool with a small, known set
      // of accounts, so a specific message helps a rep catch a typo'd
      // username rather than assuming the reset silently failed.
      return res.status(401).json({ error: 'Username not found' });
    }

    const normalizedInput = normalizePhone(phone);
    const normalizedOnFile = normalizePhone(employee.phone);
    if (!normalizedOnFile || normalizedInput !== normalizedOnFile) {
      return res.status(401).json({ error: 'Phone number does not match our records' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE employees SET password_hash = $1 WHERE id = $2', [passwordHash, employee.id]);

    return res.json({ success: true });
  } catch (err) {
    logger.error('POST /api/auth/forgot-password error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
