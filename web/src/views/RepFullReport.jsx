import React, { useState, useEffect, useCallback } from 'react';
import { Download, Route, Timer, CalendarCheck, MapPin, BellRing } from 'lucide-react';
import { apiClient } from '../api';
import {
  Card, FilterBar, Button, DataTable, MetricCard, EmptyState,
} from '../components';
import { colors, spacing } from '../theme';
import { downloadCsv, toDateInputValue, buildDynamicColumns, formatMinutesAsHours } from '../utils/reports';

const SECTIONS = [
  { key: 'attendance', title: 'Attendance', endpoint: 'attendance' },
  { key: 'dealer-visits', title: 'Dealer visits', endpoint: 'dealer-visits' },
  { key: 'exceptions', title: 'Radius exceptions', endpoint: 'exceptions' },
];

// A rep with zero visits/duration in range can get back null for an average
// (the backend avoids a division-by-zero rather than returning 0) — without
// this guard, parseFloat(null).toFixed(n) renders the literal string "NaN".
function formatNumeric(value, decimals) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n.toFixed(decimals) : '0';
}

/**
 * Consolidated per-rep report — pulls the same /api/reports/* endpoints
 * ReportsPage uses (already employee_id-filterable), scoped to one rep and
 * laid out as a single scrollable page instead of tab-switching, plus a
 * reminders section (managers previously had zero visibility into reps'
 * dealer follow-up reminders).
 */
export default function RepFullReport({ repId, employeeName }) {
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return toDateInputValue(d);
  });
  const [to, setTo] = useState(() => toDateInputValue(new Date()));

  const [sectionData, setSectionData] = useState({});
  const [rollup, setRollup] = useState(null);
  const [reminders, setReminders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { from, to, employee_id: repId };
      const [attendanceRes, visitsRes, exceptionsRes, rollupRes] = await Promise.all([
        apiClient.get('/reports/attendance', { params }),
        apiClient.get('/reports/dealer-visits', { params }),
        apiClient.get('/reports/exceptions', { params }),
        apiClient.get('/reports/distance-duration', { params }),
      ]);
      setSectionData({
        attendance: attendanceRes.data.rows,
        'dealer-visits': visitsRes.data.rows,
        exceptions: exceptionsRes.data.rows,
      });
      setRollup(rollupRes.data.rows[0] || null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load this rep\'s report.');
    } finally {
      setLoading(false);
    }
  }, [from, to, repId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Upcoming reminders aren't scoped to the date range above — a reminder is
  // a forward-looking to-do, not a historical activity record, so it's
  // fetched once per rep rather than re-fetched on every date-range change.
  useEffect(() => {
    apiClient.get('/reminders', { params: { employee_id: repId } })
      .then((res) => setReminders(res.data.reminders || []))
      .catch(() => setReminders([]));
  }, [repId]);

  const handleExport = (section) => {
    const params = new URLSearchParams({ from, to, employee_id: repId, format: 'csv' });
    downloadCsv(`/reports/${section.endpoint}?${params.toString()}`, `${employeeName || 'rep'}-${section.key}.csv`);
  };

  return (
    <div>
      <FilterBar
        onReset={() => {
          const d = new Date();
          d.setDate(d.getDate() - 30);
          setFrom(toDateInputValue(d));
          setTo(toDateInputValue(new Date()));
        }}
      >
        <div style={styles.dateField}>
          <input type="date" style={styles.dateInput} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
        </div>
        <span style={styles.filterDash}>to</span>
        <div style={styles.dateField}>
          <input type="date" style={styles.dateInput} value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
        </div>
      </FilterBar>

      {rollup && (
        <div style={styles.metricsGrid}>
          <MetricCard icon={<CalendarCheck />} value={rollup.days_worked} label="Days worked" tone="primary" />
          <MetricCard icon={<Route />} value={`${formatNumeric(rollup.total_distance_km, 1)} km`} label="Total distance" tone="warning" />
          <MetricCard icon={<Timer />} value={formatMinutesAsHours(rollup.total_duration_minutes ?? 0)} label="Total duration" tone="success" />
          <MetricCard icon={<MapPin />} value={rollup.total_visits ?? 0} label="Total visits" tone="primary" />
          <MetricCard icon={<Timer />} value={formatMinutesAsHours(rollup.avg_visit_duration_minutes ?? 0)} label="Avg visit duration" tone="neutral" />
        </div>
      )}

      {error && <EmptyState title="Couldn't load this rep's report" subtitle={error} onRetry={fetchAll} />}

      {!error && SECTIONS.map((section) => {
        const rows = sectionData[section.key] || [];
        return (
          <Card key={section.key} noPadding style={{ padding: spacing.lg, marginBottom: spacing.xl, overflow: 'hidden' }}>
            <div style={styles.sectionHeader}>
              <h3 style={styles.sectionTitle}>{section.title}</h3>
              <Button
                variant="secondary"
                icon={<Download size={13} />}
                onClick={() => handleExport(section)}
                disabled={rows.length === 0}
                style={{ height: 32, padding: '0 12px', fontSize: 12 }}
              >
                Export CSV
              </Button>
            </div>
            <DataTable
              columns={buildDynamicColumns(rows)}
              rows={rows}
              loading={loading}
              emptyTitle={`No ${section.title.toLowerCase()} in this range`}
              pageSize={10}
            />
          </Card>
        );
      })}

      <Card noPadding style={{ padding: spacing.lg, overflow: 'hidden' }}>
        <div style={styles.sectionHeader}>
          <h3 style={styles.sectionTitle}>
            <BellRing size={15} style={{ marginRight: 6, verticalAlign: -2 }} />
            Upcoming dealer reminders
          </h3>
        </div>
        <DataTable
          columns={[
            { key: 'dealer_name', label: 'Dealer' },
            { key: 'reminder_date', label: 'Date' },
            { key: 'note', label: 'Note' },
          ]}
          rows={reminders}
          emptyTitle="No reminders set"
          emptySubtitle="Follow-up reminders this rep sets for dealers will appear here."
          pageSize={10}
        />
      </Card>
    </div>
  );
}

const styles = {
  dateField: { display: 'flex', alignItems: 'center', border: `1px solid ${colors.border}`, borderRadius: 10, padding: '0 10px', height: 42 },
  dateInput: { border: 'none', outline: 'none', fontSize: 13, color: colors.text, background: 'transparent' },
  filterDash: { fontSize: 13, color: colors.textMuted },
  metricsGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: spacing.lg, marginBottom: spacing.xl,
  },
  sectionHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  sectionTitle: { fontSize: 15, fontWeight: 600, color: colors.text, margin: 0, display: 'flex', alignItems: 'center' },
};
