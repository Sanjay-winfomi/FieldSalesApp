import { apiClient } from '../api';

/**
 * reports.jsx — shared helpers for anything rendering /api/reports/* data
 * (ReportsPage's own tabs, and the per-rep report view on RepDetailsPage).
 */

export async function downloadCsv(path, filename) {
  const res = await apiClient.get(path, { responseType: 'blob' });
  const blob = new Blob([res.data], { type: 'text/csv' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

export function toDateInputValue(d) {
  return d.toISOString().slice(0, 10);
}

const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// Tables show raw report data on screen — timestamps need to read as a
// date/time a manager can scan, not the ISO string the API returns. CSV
// exports deliberately keep the raw ISO value instead (unambiguous, sortable,
// re-importable), so this formatting is display-only.
export function formatCellValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' && ISO_TIMESTAMP_PATTERN.test(value)) {
    return new Date(value).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
      timeZone: 'Asia/Kolkata',
    });
  }
  return value;
}

// A handful of abbreviations read wrong under naive per-word capitalization
// ("Total Distance Km", "Gps Accuracy") — fixed up after the generic pass.
const ACRONYM_FIXES = { Km: 'KM', Gps: 'GPS', Id: 'ID' };

// "employee_name" -> "Employee Name". Shared by every report table (and CSV
// headers are generated separately, server-side, from the raw keys — this is
// purely a display concern).
export function titleCase(key) {
  return key
    .replace(/_/g, ' ')
    .split(' ')
    .map((word) => {
      const capitalized = word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      return ACRONYM_FIXES[capitalized] || capitalized;
    })
    .join(' ');
}

// Raw primary/foreign-key fields that report rows carry for internal use
// (row identity, the exceptions "Mark reviewed" action) but that shouldn't
// be shown as a table column or exported to CSV — see reports.routes.js's
// toCsv(excludeKeys) for the CSV-side counterpart of this same exclusion.
export const ID_LIKE_KEYS = ['id', 'employee_id', 'dealer_id', 'attendance_id', 'visit_id'];

// Generic "one column per field present on the first row" builder — used
// wherever a report's shape isn't fixed ahead of time (every /reports/*
// endpoint returns different fields depending on report type). ID-like
// fields are skipped as columns but remain on the row object itself, so
// callers that need them (e.g. the exceptions row's own id) still can.
export function buildDynamicColumns(rows) {
  if (rows.length === 0) return [];
  return Object.keys(rows[0])
    .filter((key) => !ID_LIKE_KEYS.includes(key))
    .map((key) => ({
      key,
      label: titleCase(key),
      render: (row) => {
        const value = formatCellValue(row[key]);
        return <span title={String(value)}>{value}</span>;
      },
    }));
}
