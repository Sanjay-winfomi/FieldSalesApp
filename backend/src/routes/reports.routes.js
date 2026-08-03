/**
 * reports.routes.js — manager-only reporting endpoints (BA-03).
 *
 * GET /api/reports/attendance        — per-day attendance rows, exportable
 * GET /api/reports/dealer-visits     — per-visit rows, exportable
 * GET /api/reports/distance-duration — per-employee rollup over the range
 *
 * All three accept ?from=YYYY-MM-DD&to=YYYY-MM-DD&employee_id=&format=csv|json
 * (format defaults to json).
 */
const express = require('express');
const logger = require('../utils/logger');
const pool    = require('../db/pool');

const router = express.Router();

function toCsv(rows) {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (val) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(','));
  }
  return lines.join('\n');
}

// Reports that LIMIT their query to this many rows — if a result comes back
// at exactly this size, it's likely (though not certain) that more rows
// exist beyond it, so the UI can warn rather than silently showing/exporting
// a partial result with no indication anything was cut off.
const ROW_CAP = 2000;

function sendReport(res, rows, format, filename) {
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(toCsv(rows));
  }
  return res.json({ rows, count: rows.length, truncated: rows.length >= ROW_CAP });
}

// Returns an error message string if employee_id was given but isn't a valid
// integer, otherwise null.
function buildDateEmployeeFilter(query, params, conditions, dateColumn) {
  const { from, to, employee_id } = query;
  if (employee_id) {
    const employeeId = parseInt(employee_id);
    if (!Number.isInteger(employeeId)) return 'Invalid employee_id';
    params.push(employeeId);
    conditions.push(`a.employee_id = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`${dateColumn} >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`${dateColumn} <= $${params.length}::date + INTERVAL '1 day'`);
  }
  return null;
}

// Returns an error message string if dealer_id was given but isn't a valid
// integer, otherwise null.
function pushDealerIdFilter(dealerIdParam, params, conditions, column) {
  if (!dealerIdParam) return null;
  const dealerId = parseInt(dealerIdParam);
  if (!Number.isInteger(dealerId)) return 'Invalid dealer_id';
  params.push(dealerId);
  conditions.push(`${column} = $${params.length}`);
  return null;
}

// GET /api/reports/attendance
router.get('/attendance', async (req, res) => {
  const { format } = req.query;
  const conditions = [];
  const params = [];
  const filterError = buildDateEmployeeFilter(req.query, params, conditions, 'a.check_in_time');
  if (filterError) return res.status(400).json({ error: filterError });
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await pool.query(
      `SELECT e.name AS employee_name, e.region,
              a.check_in_time, a.check_out_time,
              a.total_duration_minutes, ROUND(a.total_distance_km::numeric, 2) AS total_distance_km,
              (SELECT COUNT(*) FROM client_visits cv WHERE cv.attendance_id = a.id) AS visits_count
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
       ${whereClause}
       ORDER BY a.check_in_time DESC
       LIMIT 2000`,
      params
    );

    return sendReport(res, result.rows, format, 'attendance-report.csv');
  } catch (err) {
    logger.error('GET /api/reports/attendance error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/reports/dealer-visits
router.get('/dealer-visits', async (req, res) => {
  const { format, dealer_id } = req.query;
  const conditions = [];
  const params = [];
  const filterError = buildDateEmployeeFilter(req.query, params, conditions, 'cv.check_in_time')
    || pushDealerIdFilter(dealer_id, params, conditions, 'cv.dealer_id');
  if (filterError) return res.status(400).json({ error: filterError });
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await pool.query(
      `SELECT e.name AS employee_name, d.name AS dealer_name, d.address AS dealer_address,
              cv.check_in_time, cv.check_out_time, cv.visit_duration_minutes,
              ROUND(cv.distance_from_previous_km::numeric, 2) AS distance_from_previous_km, cv.out_of_radius
       FROM client_visits cv
       JOIN attendance a ON a.id = cv.attendance_id
       JOIN employees e ON e.id = a.employee_id
       JOIN dealers d    ON d.id = cv.dealer_id
       ${whereClause}
       ORDER BY cv.check_in_time DESC
       LIMIT 2000`,
      params
    );

    return sendReport(res, result.rows, format, 'dealer-visits-report.csv');
  } catch (err) {
    logger.error('GET /api/reports/dealer-visits error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/reports/distance-duration — per-employee rollup over the range
router.get('/distance-duration', async (req, res) => {
  const { format } = req.query;
  const conditions = [];
  const params = [];
  const filterError = buildDateEmployeeFilter(req.query, params, conditions, 'a.check_in_time');
  if (filterError) return res.status(400).json({ error: filterError });
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await pool.query(
      `SELECT e.id AS employee_id, e.name AS employee_name, e.region,
              COUNT(DISTINCT a.id)                       AS days_worked,
              COALESCE(SUM(a.total_distance_km), 0)      AS total_distance_km,
              COALESCE(SUM(a.total_duration_minutes), 0) AS total_duration_minutes,
              COALESCE(COUNT(cv.id), 0)                  AS total_visits,
              COALESCE(AVG(cv.visit_duration_minutes), 0) AS avg_visit_duration_minutes
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
       LEFT JOIN client_visits cv ON cv.attendance_id = a.id
       ${whereClause}
       GROUP BY e.id, e.name, e.region
       ORDER BY e.name`,
      params
    );

    const rows = result.rows.map((r) => ({
      employee_id: r.employee_id,
      employee_name: r.employee_name,
      region: r.region,
      days_worked: parseInt(r.days_worked),
      total_distance_km: parseFloat(r.total_distance_km).toFixed(2),
      total_duration_minutes: parseInt(r.total_duration_minutes),
      total_visits: parseInt(r.total_visits),
      avg_visit_duration_minutes: parseFloat(r.avg_visit_duration_minutes).toFixed(1),
    }));

    return sendReport(res, rows, format, 'distance-duration-report.csv');
  } catch (err) {
    logger.error('GET /api/reports/distance-duration error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/reports/exceptions — read-only mirror of GET /api/visits/exceptions,
// shaped to fit ReportsPage.jsx's generic fetch/CSV-export flow. Marking an
// exception reviewed is a write action and stays on PATCH /api/visits/exceptions/:id.
router.get('/exceptions', async (req, res) => {
  const { format, employee_id, dealer_id, from, to } = req.query;
  const conditions = [];
  const params = [];
  // buildDateEmployeeFilter assumes an `a.employee_id` alias for the employee
  // filter, but this query has no attendance join — pass only from/to through
  // it and apply employee_id/dealer_id filters against `el` directly below.
  buildDateEmployeeFilter({ from, to }, params, conditions, 'el.created_at');
  const dealerFilterError = pushDealerIdFilter(dealer_id, params, conditions, 'el.dealer_id');
  if (dealerFilterError) return res.status(400).json({ error: dealerFilterError });

  let employeeId;
  if (employee_id) {
    employeeId = parseInt(employee_id);
    if (!Number.isInteger(employeeId)) {
      return res.status(400).json({ error: 'Invalid employee_id' });
    }
    params.push(employeeId);
    conditions.push(`el.employee_id = $${params.length}`);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await pool.query(
      `SELECT el.id, e.name AS employee_name, d.name AS dealer_name, el.event_type,
              el.latitude, el.longitude, ROUND(el.distance_meters::numeric, 1) AS distance_meters,
              ROUND(el.gps_accuracy_m::numeric, 1) AS gps_accuracy_m, el.reason,
              el.matched_check_in, el.manager_reviewed, el.created_at
       FROM exception_log el
       JOIN employees e ON e.id = el.employee_id
       JOIN dealers d    ON d.id = el.dealer_id
       ${whereClause}
       ORDER BY el.created_at DESC
       LIMIT 2000`,
      params
    );

    return sendReport(res, result.rows, format, 'exceptions-report.csv');
  } catch (err) {
    logger.error('GET /api/reports/exceptions error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
