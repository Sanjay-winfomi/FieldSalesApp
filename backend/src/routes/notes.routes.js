/**
 * notes.routes.js — free-form notepad entries.
 *
 * POST   /api/notes      — create a note (100-char minimum)
 * GET    /api/notes      — list the caller's own notes; a manager may pass
 *                           ?employee_id= to view a rep's notes
 * GET    /api/notes/:id  — fetch a single note (owner or manager)
 * PUT    /api/notes/:id  — edit the caller's own note (100-char minimum still applies)
 * DELETE /api/notes/:id  — delete the caller's own note
 */
const express = require('express');
const logger = require('../utils/logger');
const pool    = require('../db/pool');

const router = express.Router();

const MIN_CONTENT_LENGTH = 100;
const NOTE_FIELDS = 'id, employee_id, content, created_at, updated_at';

function validateContent(content) {
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  return trimmed.length >= MIN_CONTENT_LENGTH ? trimmed : null;
}

// POST /api/notes
router.post('/', async (req, res) => {
  const trimmed = validateContent(req.body.content);
  if (!trimmed) {
    return res.status(422).json({ error: 'content_too_short', minLength: MIN_CONTENT_LENGTH });
  }

  try {
    const result = await pool.query(
      `INSERT INTO notes (employee_id, content) VALUES ($1, $2) RETURNING ${NOTE_FIELDS}`,
      [req.employee.id, trimmed]
    );
    return res.status(201).json({ note: result.rows[0] });
  } catch (err) {
    logger.error('POST /api/notes error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/notes
router.get('/', async (req, res) => {
  const isManager = req.employee.role === 'manager';
  const { employee_id } = req.query;

  try {
    let targetEmployeeId = req.employee.id;
    if (isManager && employee_id) {
      targetEmployeeId = parseInt(employee_id);
      if (!Number.isInteger(targetEmployeeId)) {
        return res.status(400).json({ error: 'Invalid employee_id' });
      }
    }

    const result = await pool.query(
      `SELECT ${NOTE_FIELDS} FROM notes WHERE employee_id = $1 ORDER BY updated_at DESC LIMIT 500`,
      [targetEmployeeId]
    );
    return res.json({ notes: result.rows });
  } catch (err) {
    logger.error('GET /api/notes error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/notes/:id
router.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid note id' });
  }

  try {
    const result = await pool.query(`SELECT ${NOTE_FIELDS} FROM notes WHERE id = $1`, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }

    const note = result.rows[0];
    const isManager = req.employee.role === 'manager';
    if (!isManager && note.employee_id !== req.employee.id) {
      return res.status(403).json({ error: 'Not authorized to view this note' });
    }

    return res.json({ note });
  } catch (err) {
    logger.error('GET /api/notes/:id error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/notes/:id
router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid note id' });
  }
  const trimmed = validateContent(req.body.content);
  if (!trimmed) {
    return res.status(422).json({ error: 'content_too_short', minLength: MIN_CONTENT_LENGTH });
  }

  try {
    const existing = await pool.query('SELECT employee_id FROM notes WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }
    if (existing.rows[0].employee_id !== req.employee.id) {
      return res.status(403).json({ error: 'Not authorized to edit this note' });
    }

    const result = await pool.query(
      `UPDATE notes SET content = $1, updated_at = NOW() WHERE id = $2 RETURNING ${NOTE_FIELDS}`,
      [trimmed, id]
    );
    return res.json({ note: result.rows[0] });
  } catch (err) {
    logger.error('PUT /api/notes/:id error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/notes/:id
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid note id' });
  }

  try {
    const existing = await pool.query('SELECT employee_id FROM notes WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Note not found' });
    }
    if (existing.rows[0].employee_id !== req.employee.id) {
      return res.status(403).json({ error: 'Not authorized to delete this note' });
    }

    await pool.query('DELETE FROM notes WHERE id = $1', [id]);
    return res.json({ success: true });
  } catch (err) {
    logger.error('DELETE /api/notes/:id error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
