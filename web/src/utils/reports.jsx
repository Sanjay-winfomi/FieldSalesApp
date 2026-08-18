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

// Every duration the backend returns is in raw minutes (attendance/visit
// duration columns, rollup averages) — every one of those field names ends
// in "_minutes" by convention, which is what lets this be applied generically
// instead of an explicit per-field allowlist.
const MINUTES_KEY_PATTERN = /_minutes$/;

// "Xh Ym" everywhere, matching the mobile app's own formatDuration
// (activityHistory.js) — a manager reading 14836 raw minutes has no quick
// sense of scale; 247h 16m (or, worse, the same number relabeled "hours"
// without dividing it) does.
export function formatMinutesAsHours(minutes) {
  // Number(null) is 0, not NaN — checked explicitly so a missing value
  // reads as "—" (no data) rather than the misleading "0h 0m" (zero duration).
  if (minutes === null || minutes === undefined) return '—';
  const n = Number(minutes);
  if (!Number.isFinite(n)) return '—';
  if (n < 1) return '0h 0m';
  const h = Math.floor(n / 60);
  const m = Math.round(n % 60);
  return `${h}h ${m}m`;
}

// Tables show raw report data on screen — timestamps need to read as a
// date/time a manager can scan, not the ISO string the API returns, and
// durations need to read in hours/minutes, not raw minutes. CSV exports
// deliberately keep the raw values instead (unambiguous, sortable,
// re-importable), so this formatting is display-only.
export function formatCellValue(value, key) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string' && ISO_TIMESTAMP_PATTERN.test(value)) {
    return new Date(value).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
      timeZone: 'Asia/Kolkata',
    });
  }
  if (key && MINUTES_KEY_PATTERN.test(key) && typeof value === 'number') {
    return formatMinutesAsHours(value);
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
  // Union of keys across ALL rows, not just rows[0] — a heterogeneous
  // report (e.g. exceptions/dealer-visits, where later rows can carry a
  // nullable column the first row happens to lack) would otherwise render
  // that field for every row as invisible, since a column that isn't in
  // rows[0] is never generated at all. Insertion order still favors
  // rows[0]'s own key order, with any keys unique to later rows appended.
  const allKeys = new Set();
  rows.forEach((row) => Object.keys(row).forEach((key) => allKeys.add(key)));
  return Array.from(allKeys)
    .filter((key) => !ID_LIKE_KEYS.includes(key))
    .map((key) => ({
      key,
      // Strip "_minutes" from the header instead of relabeling it "_hours"
      // — the cell itself already reads "13h 55m", so repeating a bare unit
      // in the header would be redundant ("Total Duration Hours: 13h 55m").
      label: titleCase(key.replace(MINUTES_KEY_PATTERN, '')),
      render: (row) => {
        const value = formatCellValue(row[key], key);
        return <span title={String(value)}>{value}</span>;
      },
    }));
}
