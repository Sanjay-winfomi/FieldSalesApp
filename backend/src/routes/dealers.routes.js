/**
 * dealers.routes.js — Stage 5 + admin CRUD + not-visited alert
 *
 * GET    /api/dealers              — list all dealers (supports ?search= query param)
 * GET    /api/dealers/not-visited  — manager-only: dealers with no visit in the last N days
 * POST   /api/dealers              — manager-only: create a dealer
 * PUT    /api/dealers/:id          — manager-only: update a dealer
 * DELETE /api/dealers/:id          — manager-only: remove a dealer with no recorded visits
 */
const express = require('express');
const logger = require('../utils/logger');
const pool    = require('../db/pool');
const { requireRole } = require('../middleware/auth.middleware');

const router = express.Router();

const DEALER_FIELDS = 'id, name, address, latitude, longitude, contact_person, contact_phone, radius_meters';

// GET /api/dealers
router.get('/', async (req, res) => {
  const { search } = req.query;

  try {
    let query, params;

    if (search && search.trim()) {
      // Escape LIKE metacharacters so a literal "%" or "_" in a dealer name
      // (e.g. "100% Fresh Mart") is matched literally instead of acting as a
      // wildcard.
      const escaped = search.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
      const pattern = `%${escaped}%`;
      query = `
        SELECT ${DEALER_FIELDS}
        FROM dealers
        WHERE name ILIKE $1 ESCAPE '\\' OR address ILIKE $1 ESCAPE '\\'
        ORDER BY name
      `;
      params = [pattern];
    } else {
      query = `
        SELECT ${DEALER_FIELDS}
        FROM dealers
        ORDER BY name
      `;
      params = [];
    }

    const result = await pool.query(query, params);
    return res.json({ dealers: result.rows });
  } catch (err) {
    logger.error('GET /api/dealers error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/dealers/not-visited?days=7
router.get('/not-visited', requireRole('manager'), async (req, res) => {
  const days = parseInt(req.query.days) || 7;

  try {
    const result = await pool.query(
      `SELECT d.${DEALER_FIELDS.split(', ').join(', d.')}, MAX(cv.login_time) AS last_visit_time
       FROM dealers d
       LEFT JOIN client_visits cv ON cv.dealer_id = d.id
       GROUP BY d.id
       HAVING MAX(cv.login_time) IS NULL
           OR MAX(cv.login_time) < NOW() - ($1 || ' days')::INTERVAL
       ORDER BY last_visit_time ASC NULLS FIRST`,
      [days]
    );

    return res.json({ dealers: result.rows, threshold_days: days });
  } catch (err) {
    logger.error('GET /api/dealers/not-visited error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/dealers
router.post('/', requireRole('manager'), async (req, res) => {
  const { name, address, latitude, longitude, contact_person, contact_phone, radius_meters } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO dealers (name, address, latitude, longitude, contact_person, contact_phone, radius_meters)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 200))
       RETURNING ${DEALER_FIELDS}`,
      [name, address || null, latitude ?? null, longitude ?? null, contact_person || null, contact_phone || null, radius_meters ?? null]
    );

    return res.status(201).json({ dealer: result.rows[0] });
  } catch (err) {
    logger.error('POST /api/dealers error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/dealers/:id
router.put('/:id', requireRole('manager'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid dealer id' });
  }
  const { name, address, latitude, longitude, contact_person, contact_phone, radius_meters } = req.body;

  try {
    const existing = await pool.query('SELECT id FROM dealers WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Dealer not found' });
    }

    const result = await pool.query(
      `UPDATE dealers
       SET name           = COALESCE($1, name),
           address        = COALESCE($2, address),
           latitude       = COALESCE($3, latitude),
           longitude      = COALESCE($4, longitude),
           contact_person = COALESCE($5, contact_person),
           contact_phone  = COALESCE($6, contact_phone),
           radius_meters  = COALESCE($7, radius_meters)
       WHERE id = $8
       RETURNING ${DEALER_FIELDS}`,
      [name, address, latitude, longitude, contact_person, contact_phone, radius_meters, id]
    );

    return res.json({ dealer: result.rows[0] });
  } catch (err) {
    logger.error('PUT /api/dealers/:id error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/dealers/:id
router.delete('/:id', requireRole('manager'), async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid dealer id' });
  }

  try {
    const existing = await pool.query('SELECT id FROM dealers WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Dealer not found' });
    }

    // Unlike employees, dealers aren't ON DELETE CASCADE from client_visits /
    // exception_log (visit history shouldn't silently vanish just because a
    // dealer record is removed) — so a dealer with recorded visits can't be
    // deleted outright. Check up front for a clear message instead of
    // surfacing the raw foreign-key violation as a generic 500.
    const visitCount = await pool.query('SELECT COUNT(*)::int AS count FROM client_visits WHERE dealer_id = $1', [id]);
    if (visitCount.rows[0].count > 0) {
      return res.status(409).json({
        error: `Cannot delete — ${visitCount.rows[0].count} recorded visit(s) reference this dealer. Edit it instead if it's no longer active.`,
      });
    }

    await pool.query('DELETE FROM dealers WHERE id = $1', [id]);
    return res.json({ success: true });
  } catch (err) {
    logger.error('DELETE /api/dealers/:id error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
