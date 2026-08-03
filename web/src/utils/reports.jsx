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

// Generic "one column per field present on the first row" builder — used
// wherever a report's shape isn't fixed ahead of time (every /reports/*
// endpoint returns different fields depending on report type).
export function buildDynamicColumns(rows) {
  if (rows.length === 0) return [];
  return Object.keys(rows[0]).map((key) => ({
    key,
    label: key.replace(/_/g, ' '),
    render: (row) => {
      const value = formatCellValue(row[key]);
      return <span title={String(value)}>{value}</span>;
    },
  }));
}
