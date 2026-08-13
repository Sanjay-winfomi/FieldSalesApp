/**
 * employees.routes.js — manager-only admin CRUD for field reps and managers.
 *
 * GET    /api/employees        — list employees (optional ?role=)
 * POST   /api/employees        — create a new employee
 * PUT    /api/employees/:id    — update name/phone/region/role/is_active
 * DELETE /api/employees/:id    — permanently remove an employee
 * POST   /api/employees/:id/reset-password — set a new password
 */
const express = require('express');
const logger = require('../utils/logger');
const bcrypt  = require('bcryptjs');
const pool    = require('../db/pool');

const router = express.Router();

const PUBLIC_FIELDS = 'id, name, phone, username, role, region, is_active, created_at';

// GET /api/employees
router.get('/', async (req, res) => {
  const { role } = req.query;

  try {
    let result;
    if (role) {
      result = await pool.query(
        `SELECT ${PUBLIC_FIELDS} FROM employees WHERE role = $1 ORDER BY name`,
        [role]
      );
    } else {
      result = await pool.query(`SELECT ${PUBLIC_FIELDS} FROM employees ORDER BY name`);
    }
    return res.json({ employees: result.rows });
  } catch (err) {
    logger.error('GET /api/employees error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/employees
router.post('/', async (req, res) => {
  const { name, phone, username, password, role, region } = req.body;

  if (!name || !username || !password || !role) {
    return res.status(400).json({ error: 'name, username, password, and role are required' });
  }
  if (!['rep', 'manager'].includes(role)) {
    return res.status(400).json({ error: "role must be 'rep' or 'manager'" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }

  try {
    // Case-insensitive, matching login's case-insensitive lookup — otherwise
    // "Tamil.Kumar" and "tamil.kumar" could exist as two separate accounts.
    const existing = await pool.query('SELECT id FROM employees WHERE LOWER(username) = LOWER($1)', [username]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO employees (name, phone, username, password_hash, role, region)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${PUBLIC_FIELDS}`,
      [name, phone || null, username, passwordHash, role, region || null]
    );

    return res.status(201).json({ employee: result.rows[0] });
  } catch (err) {
    logger.error('POST /api/employees error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/employees/:id
router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid employee id' });
  }
  const { name, phone, region, role, is_active } = req.body;

  if (role && !['rep', 'manager'].includes(role)) {
    return res.status(400).json({ error: "role must be 'rep' or 'manager'" });
  }
  // `name` in req.body distinguishes "field omitted" (keep existing) from
  // "explicitly sent" — COALESCE($1, name) below only guards against SQL
  // NULL, not an empty string, so { name: "" } would otherwise blank out a
  // field POST /api/employees requires to be non-empty at creation time.
  if ('name' in req.body && !name) {
    return res.status(400).json({ error: 'name cannot be empty' });
  }

  try {
    const existing = await pool.query('SELECT id, phone, region FROM employees WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    // COALESCE can't distinguish "field omitted" from "field explicitly set to
    // null" — so phone/region must use `'key' in req.body` to allow clearing
    // them, instead of always falling back to the old value.
    const nextPhone   = 'phone'  in req.body ? phone  : existing.rows[0]?.phone;
    const nextRegion  = 'region' in req.body ? region : existing.rows[0]?.region;

    const result = await pool.query(
      `UPDATE employees
       SET name      = COALESCE($1, name),
           phone     = $2,
           region    = $3,
           role      = COALESCE($4, role),
           is_active = COALESCE($5, is_active)
       WHERE id = $6
       RETURNING ${PUBLIC_FIELDS}`,
      [name, nextPhone ?? null, nextRegion ?? null, role, is_active, id]
    );

    return res.json({ employee: result.rows[0] });
  } catch (err) {
    logger.error('PUT /api/employees/:id error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/employees/:id
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid employee id' });
  }

  // A manager deleting their own account mid-session would invalidate the
  // token they're using for this very request on the next call — deactivating
  // (or having another manager delete them) is the supported path instead.
  if (id === req.employee.id) {
    return res.status(400).json({ error: 'You cannot delete your own account.' });
  }

  try {
    // Deleting an employee cascades to their attendance + client_visits +
    // exception_log rows (ON DELETE CASCADE in schema.sql) — this permanently
    // erases their attendance/visit history, not just the account. Deactivate
    // instead (PUT is_active=false) when the history should be kept.
    const result = await pool.query('DELETE FROM employees WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Employee not found' });
    }
    return res.json({ success: true });
  } catch (err) {
    logger.error('DELETE /api/employees/:id error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/employees/:id/reset-password
router.post('/:id/reset-password', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid employee id' });
  }
  const { password } = req.body;

  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'UPDATE employees SET password_hash = $1 WHERE id = $2 RETURNING id',
      [passwordHash, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    return res.json({ success: true });
  } catch (err) {
    logger.error('POST /api/employees/:id/reset-password error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
