/**
 * dealers.routes.js — Stage 5 + admin CRUD + not-visited alert
 *
 * GET    /api/dealers              — list all dealers (supports ?search= query param)
 * GET    /api/dealers/not-visited  — manager-only: dealers with no visit in the last N days
 * POST   /api/dealers              — manager-only: create a dealer
 * PUT    /api/dealers/:id          — manager-only: update a dealer
 * DELETE /api/dealers/:id          — manager-only: remove a dealer (cascades to its visits,
 *                                      exceptions, assignments, reminders, and notifications —
 *                                      see schema.sql's dealer-cascade block)
 */
const express = require('express');
const logger = require('../utils/logger');
const pool    = require('../db/pool');
const { requireRole } = require('../middleware/auth.middleware');
const { createManagerNotification } = require('../utils/managerNotifications');
const { getBusinessDateString } = require('../utils/businessDay');

const router = express.Router();

const DEALER_FIELDS = 'id, name, address, latitude, longitude, contact_person, contact_phone, radius_meters';

// Coerces a coordinate/radius field to a finite number within range, or
// returns undefined for "not provided" (so callers can distinguish that from
// "provided but invalid") — null/'' pass through as "not provided" since the
// mobile client's forms send those for an intentionally-cleared field.
function parseOptionalNumber(value, min, max) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n) || n < min || n > max) return null; // null = invalid
  return n;
}

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
  // `parseInt('0') || 7` treats an explicit days=0 as falsy and silently
  // falls back to the default instead of honoring it (or rejecting it) —
  // check for NaN specifically instead, and reject anything <= 0.
  const daysParam = req.query.days;
  const days = daysParam === undefined ? 7 : parseInt(daysParam);
  if (!Number.isInteger(days) || days <= 0) {
    return res.status(400).json({ error: 'days must be a positive integer' });
  }

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

  const lat = parseOptionalNumber(latitude, -90, 90);
  const lng = parseOptionalNumber(longitude, -180, 180);
  const radius = parseOptionalNumber(radius_meters, 1, 100000);
  if (lat === null || lng === null) {
    return res.status(400).json({ error: 'latitude and longitude must be valid numbers (-90..90, -180..180)' });
  }
  if (radius === null) {
    return res.status(400).json({ error: 'radius_meters must be a positive number' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO dealers (name, address, latitude, longitude, contact_person, contact_phone, radius_meters)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 200))
       RETURNING ${DEALER_FIELDS}`,
      [name, address || null, lat ?? null, lng ?? null, contact_person || null, contact_phone || null, radius ?? null]
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

  const lat = parseOptionalNumber(latitude, -90, 90);
  const lng = parseOptionalNumber(longitude, -180, 180);
  const radius = parseOptionalNumber(radius_meters, 1, 100000);
  if (lat === null || lng === null) {
    return res.status(400).json({ error: 'latitude and longitude must be valid numbers (-90..90, -180..180)' });
  }
  if (radius === null) {
    return res.status(400).json({ error: 'radius_meters must be a positive number' });
  }

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
      [name, address, lat, lng, contact_person, contact_phone, radius, id]
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

  // The two "what's about to be lost" reads and the DELETE itself run in one
  // transaction so the counts reported back are an exact snapshot of what
  // this DELETE actually removed, not a value that a concurrent write
  // between separate autocommit statements could make stale (e.g. a
  // follow-up request created between the SELECT and the DELETE would
  // otherwise vanish with the cascade but never appear in the notification).
  const client = await pool.connect();
  let visitCount;
  let affectedResult;
  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT id FROM dealers WHERE id = $1 FOR UPDATE', [id]);
    if (existing.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ error: 'Dealer not found' });
    }

    // Deletes cascade (schema.sql) — removing a dealer also permanently
    // removes its visit history, exception records, radius-event history,
    // notifications, and reminders. Counted up front (not to block the
    // delete, just to report what was actually removed) since this is
    // irreversible.
    visitCount = await client.query('SELECT COUNT(*)::int AS count FROM client_visits WHERE dealer_id = $1', [id]);

    // A pending follow-up request or a not-yet-completed future assignment
    // for this dealer represents an in-flight workflow a rep is actively
    // waiting on — unlike visit history, silently cascading these away with
    // no trace would leave the rep never finding out why their request/plan
    // vanished. Captured up front so the manager can be told what else this
    // delete took with it.
    affectedResult = await client.query(
      `SELECT e.id AS employee_id, e.name AS employee_name
       FROM dealer_followup_requests r
       JOIN employees e ON e.id = r.employee_id
       WHERE r.dealer_id = $1 AND r.status = 'pending'
       UNION
       SELECT e.id AS employee_id, e.name AS employee_name
       FROM dealer_assignments a
       JOIN employees e ON e.id = a.employee_id
       WHERE a.dealer_id = $1 AND a.status NOT IN ('completed', 'cancelled')
         AND a.assignment_date >= $2::date`,
      [id, getBusinessDateString()]
    );

    await client.query('DELETE FROM dealers WHERE id = $1', [id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('DELETE /api/dealers/:id error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }

  try {
    if (affectedResult.rows.length > 0) {
      const names = affectedResult.rows.map((r) => r.employee_name).join(', ');
      await createManagerNotification({
        type: 'dealer_deleted_with_pending_work',
        title: 'Dealer deleted with pending rep work',
        body: `Deleting this dealer also removed a pending follow-up request or upcoming assignment for: ${names}. Let them know directly, since they won't see any notice of this on their own.`,
        severity: 'warning',
      });
    }

    return res.json({ success: true, deletedVisitCount: visitCount.rows[0].count });
  } catch (err) {
    logger.error('DELETE /api/dealers/:id error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
