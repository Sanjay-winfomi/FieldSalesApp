/**
 * reminders.routes.js — dealer follow-up reminders.
 *
 * POST   /api/reminders                 — create a reminder (20-char note minimum)
 * GET    /api/reminders                 — list the caller's own reminders; a
 *                                          manager may pass ?employee_id= to
 *                                          view a rep's reminders
 * PATCH  /api/reminders/:id/notifications — persist locally-scheduled notification ids
 * DELETE /api/reminders/:id             — delete the caller's own reminder
 */
const express = require('express');
const logger = require('../utils/logger');
const pool    = require('../db/pool');

const router = express.Router();

const MIN_NOTE_LENGTH = 20;
const REMINDER_FIELDS = 'id, employee_id, dealer_id, reminder_date, note, '
  + 'notif_id_day_before, notif_id_day_of, created_at';

function validateNote(note) {
  if (typeof note !== 'string') return null;
  const trimmed = note.trim();
  return trimmed.length >= MIN_NOTE_LENGTH ? trimmed : null;
}

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

// POST /api/reminders
router.post('/', async (req, res) => {
  const dealerId = parseInt(req.body.dealer_id);
  if (!Number.isInteger(dealerId)) {
    return res.status(400).json({ error: 'Invalid dealer_id' });
  }

  const reminderDate = req.body.reminder_date;
  if (typeof reminderDate !== 'string' || Number.isNaN(Date.parse(reminderDate))) {
    return res.status(400).json({ error: 'Invalid reminder_date' });
  }
  if (reminderDate < todayDateString()) {
    return res.status(422).json({ error: 'reminder_date_in_past' });
  }

  const trimmed = validateNote(req.body.note);
  if (!trimmed) {
    return res.status(422).json({ error: 'note_too_short', minLength: MIN_NOTE_LENGTH });
  }

  try {
    const dealer = await pool.query('SELECT id FROM dealers WHERE id = $1', [dealerId]);
    if (dealer.rows.length === 0) {
      return res.status(404).json({ error: 'Dealer not found' });
    }

    const result = await pool.query(
      `INSERT INTO reminders (employee_id, dealer_id, reminder_date, note)
       VALUES ($1, $2, $3, $4) RETURNING ${REMINDER_FIELDS}`,
      [req.employee.id, dealerId, reminderDate, trimmed]
    );
    return res.status(201).json({ reminder: result.rows[0] });
  } catch (err) {
    logger.error('POST /api/reminders error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/reminders
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
      `SELECT r.id, r.employee_id, r.dealer_id, r.reminder_date, r.note,
              r.notif_id_day_before, r.notif_id_day_of, r.created_at, d.name AS dealer_name
       FROM reminders r
       JOIN dealers d ON d.id = r.dealer_id
       WHERE r.employee_id = $1
       ORDER BY r.reminder_date ASC LIMIT 500`,
      [targetEmployeeId]
    );
    return res.json({ reminders: result.rows });
  } catch (err) {
    logger.error('GET /api/reminders error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /api/reminders/:id/notifications
router.patch('/:id/notifications', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid reminder id' });
  }

  const { notif_id_day_before: notifIdDayBefore, notif_id_day_of: notifIdDayOf } = req.body;

  try {
    const existing = await pool.query('SELECT employee_id FROM reminders WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Reminder not found' });
    }
    if (existing.rows[0].employee_id !== req.employee.id) {
      return res.status(403).json({ error: 'Not authorized to edit this reminder' });
    }

    const result = await pool.query(
      `UPDATE reminders SET notif_id_day_before = $1, notif_id_day_of = $2
       WHERE id = $3 RETURNING ${REMINDER_FIELDS}`,
      [notifIdDayBefore || null, notifIdDayOf || null, id]
    );
    return res.json({ reminder: result.rows[0] });
  } catch (err) {
    logger.error('PATCH /api/reminders/:id/notifications error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/reminders/:id
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid reminder id' });
  }

  try {
    const existing = await pool.query('SELECT employee_id FROM reminders WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Reminder not found' });
    }
    if (existing.rows[0].employee_id !== req.employee.id) {
      return res.status(403).json({ error: 'Not authorized to delete this reminder' });
    }

    await pool.query('DELETE FROM reminders WHERE id = $1', [id]);
    return res.json({ success: true });
  } catch (err) {
    logger.error('DELETE /api/reminders/:id error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
