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
const { businessDateExpr } = require('../utils/businessDay');

const router = express.Router();

// Raw primary/foreign-key fields kept on report rows for internal use (the
// exceptions "Mark reviewed" action needs `id`) but excluded from the CSV
// itself — mirrors ID_LIKE_KEYS in web/src/utils/reports.jsx, which does the
// same exclusion for the on-screen table columns.
const ID_LIKE_KEYS = ['id', 'employee_id', 'dealer_id', 'attendance_id', 'visit_id'];

function toCsv(rows, excludeKeys = []) {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]).filter((h) => !excludeKeys.includes(h));
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
  const truncated = rows.length >= ROW_CAP;
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // The JSON branch has a `truncated` body field; a raw CSV download has no
    // body to attach one to, so this header is the equivalent signal that
    // the export was capped at ROW_CAP rows and isn't the complete result.
    res.setHeader('X-Report-Truncated', String(truncated));
    return res.send(toCsv(rows, ID_LIKE_KEYS));
  }
  return res.json({ rows, count: rows.length, truncated });
}

// Strict YYYY-MM-DD check — Date.parse() accepts many non-ISO formats
// (including some whose string order doesn't match calendar order), and an
// outright malformed value like "abc" reaches Postgres's own date cast and
// surfaces as an uncaught 500 instead of a clean 400.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDateString(value) {
  if (typeof value !== 'string' || !DATE_ONLY_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime());
}

// Returns an error message string if employee_id/employee_ids was given but
// invalid, otherwise null. `employee_ids` (comma-separated, from the report
// filter's multi-select) takes precedence over the older singular
// `employee_id` (still used as-is by RepFullReport.jsx) when both are present.
function buildDateEmployeeFilter(query, params, conditions, dateColumn) {
  const { from, to, employee_id, employee_ids } = query;
  if (employee_ids) {
    const ids = employee_ids.split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isInteger);
    if (ids.length === 0) return 'Invalid employee_ids';
    params.push(ids);
    conditions.push(`a.employee_id = ANY($${params.length}::int[])`);
  } else if (employee_id) {
    const employeeId = parseInt(employee_id);
    if (!Number.isInteger(employeeId)) return 'Invalid employee_id';
    params.push(employeeId);
    conditions.push(`a.employee_id = $${params.length}`);
  }
  // Filtered against the app's business-day boundary (5am IST rollover, see
  // businessDay.js), not the raw UTC calendar date — otherwise a manager
  // filtering by a given date got results that don't match what the app
  // itself (and the rep's own device) considers that business day for any
  // record near the boundary.
  if (from) {
    if (!isValidDateString(from)) return 'Invalid from date (expected YYYY-MM-DD)';
    params.push(from);
    conditions.push(`${businessDateExpr(dateColumn)} >= $${params.length}::date`);
  }
  if (to) {
    if (!isValidDateString(to)) return 'Invalid to date (expected YYYY-MM-DD)';
    params.push(to);
    conditions.push(`${businessDateExpr(dateColumn)} <= $${params.length}::date`);
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
  const filterError = buildDateEmployeeFilter(req.query, params, conditions, 'a.login_time');
  if (filterError) return res.status(400).json({ error: filterError });
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await pool.query(
      `SELECT e.name AS employee_name, e.region,
              a.login_time, a.logout_time,
              a.total_duration_minutes, ROUND(a.total_distance_km::numeric, 2) AS total_distance_km,
              (SELECT COUNT(*) FROM client_visits cv WHERE cv.attendance_id = a.id) AS visits_count
       FROM attendance a
       JOIN employees e ON e.id = a.employee_id
       ${whereClause}
       ORDER BY a.login_time DESC
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
  const filterError = buildDateEmployeeFilter(req.query, params, conditions, 'cv.login_time')
    || pushDealerIdFilter(dealer_id, params, conditions, 'cv.dealer_id');
  if (filterError) return res.status(400).json({ error: filterError });
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await pool.query(
      `SELECT e.name AS employee_name, d.name AS dealer_name, d.address AS dealer_address,
              cv.login_time, cv.logout_time, cv.visit_duration_minutes,
              ROUND(cv.distance_from_previous_km::numeric, 2) AS distance_from_previous_km, cv.out_of_radius,
              cv.login_inside_radius,
              (cv.login_inside_radius = false AND cv.out_of_radius = true) AS needs_verification
       FROM client_visits cv
       JOIN attendance a ON a.id = cv.attendance_id
       JOIN employees e ON e.id = a.employee_id
       JOIN dealers d    ON d.id = cv.dealer_id
       ${whereClause}
       ORDER BY cv.login_time DESC
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
  const filterError = buildDateEmployeeFilter(req.query, params, conditions, 'a.login_time');
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
  const { format, employee_id, employee_ids, dealer_id, from, to } = req.query;
  const conditions = [];
  const params = [];
  // buildDateEmployeeFilter assumes an `a.employee_id` alias for the employee
  // filter, but this query has no attendance join — pass only from/to through
  // it and apply employee_id/dealer_id filters against `el` directly below.
  const dateFilterError = buildDateEmployeeFilter({ from, to }, params, conditions, 'el.created_at');
  if (dateFilterError) return res.status(400).json({ error: dateFilterError });
  const dealerFilterError = pushDealerIdFilter(dealer_id, params, conditions, 'el.dealer_id');
  if (dealerFilterError) return res.status(400).json({ error: dealerFilterError });

  if (employee_ids) {
    const ids = employee_ids.split(',').map((s) => parseInt(s.trim(), 10)).filter(Number.isInteger);
    if (ids.length === 0) return res.status(400).json({ error: 'Invalid employee_ids' });
    params.push(ids);
    conditions.push(`el.employee_id = ANY($${params.length}::int[])`);
  } else if (employee_id) {
    const employeeId = parseInt(employee_id);
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
              el.matched_login, el.manager_reviewed, el.created_at,
              -- Task 5 Case 3: an exception at BOTH login and logout for the
              -- same visit — surfaced per-row (each row already carries its
              -- own reason/distance/accuracy) rather than needing a new
              -- combined-row endpoint.
              EXISTS (
                SELECT 1 FROM exception_log el2
                WHERE el2.visit_id = el.visit_id
                  AND el2.event_type <> el.event_type
                  AND el2.event_type IN ('login', 'logout')
              ) AS needs_verification
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
