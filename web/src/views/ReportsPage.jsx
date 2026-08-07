import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Download, AlertTriangle, RotateCcw } from 'lucide-react';
import { apiClient } from '../api';
import {
  SectionHeader, FilterSelect, RepMultiSelect, Button, Card, FilterBar, DataTable, EmptyState,
} from '../components';
import { colors, typography, spacing } from '../theme';
import { downloadCsv, toDateInputValue, buildDynamicColumns } from '../utils/reports';

const REPORT_TABS = [
  { key: 'attendance', label: 'Attendance' },
  { key: 'dealer-visits', label: 'Dealer visits' },
  { key: 'distance-duration', label: 'Distance & duration' },
  { key: 'exceptions', label: 'Exceptions' },
];

export default function ReportsPage() {
  const [activeTab, setActiveTab] = useState('attendance');
  const [employees, setEmployees] = useState([]);
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState([]);
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return toDateInputValue(d);
  });
  const [to, setTo] = useState(() => toDateInputValue(new Date()));
  const [rows, setRows] = useState([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [notVisited, setNotVisited] = useState([]);
  const [notVisitedDays, setNotVisitedDays] = useState(7);

  useEffect(() => {
    apiClient.get('/employees?role=rep').then((res) => setEmployees(res.data.employees)).catch(() => {});
  }, []);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { from, to };
      if (selectedEmployeeIds.length > 0) params.employee_ids = selectedEmployeeIds.join(',');
      const res = await apiClient.get(`/reports/${activeTab}`, { params });
      setRows(res.data.rows);
      setTruncated(!!res.data.truncated);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load report.');
      setRows([]);
      setTruncated(false);
    } finally {
      setLoading(false);
    }
  }, [activeTab, from, to, selectedEmployeeIds]);

  useEffect(() => {
    fetchReport();
  }, [fetchReport]);

  const fetchNotVisited = useCallback(async () => {
    try {
      const res = await apiClient.get('/dealers/not-visited', { params: { days: notVisitedDays } });
      setNotVisited(res.data.dealers);
    } catch {
      setNotVisited([]);
    }
  }, [notVisitedDays]);

  useEffect(() => {
    fetchNotVisited();
  }, [fetchNotVisited]);

  const handleExport = () => {
    const params = new URLSearchParams({ from, to, format: 'csv' });
    if (selectedEmployeeIds.length > 0) params.set('employee_ids', selectedEmployeeIds.join(','));
    downloadCsv(`/reports/${activeTab}?${params.toString()}`, `${activeTab}-report.csv`);
  };

  const markExceptionReviewed = useCallback(async (id) => {
    try {
      await apiClient.patch(`/visits/exceptions/${id}`, { reviewed: true });
      fetchReport();
    } catch {
      // Leave the row as-is — the user can retry the click.
    }
  }, [fetchReport]);

  const columns = useMemo(() => {
    const base = buildDynamicColumns(rows);
    if (activeTab !== 'exceptions') return base;
    return [
      ...base,
      {
        key: 'review_action',
        label: '',
        sortable: false,
        render: (row) => row.manager_reviewed ? null : (
          <Button variant="secondary" style={{ height: 30, padding: '0 10px', fontSize: 12 }} onClick={() => markExceptionReviewed(row.id)}>
            Mark reviewed
          </Button>
        ),
      },
    ];
  }, [rows, activeTab, markExceptionReviewed]);

  return (
    <div style={styles.page} className="ft-page">
      <SectionHeader
        title="Reports"
        subtitle="Attendance, dealer visits, and distance/duration across your team"
      />

      <Card style={styles.alertCard}>
        <div style={styles.alertHeader}>
          <AlertTriangle size={16} color={colors.warningDark} style={{ marginRight: 8 }} />
          <span style={styles.alertTitle}>Dealers not visited</span>
          <FilterSelect
            value={notVisitedDays}
            onChange={(v) => setNotVisitedDays(parseInt(v))}
            ariaLabel="Days since last visit threshold"
            style={{ minWidth: 120 }}
            options={[
              { value: 3, label: '3+ days' },
              { value: 7, label: '7+ days' },
              { value: 14, label: '14+ days' },
              { value: 30, label: '30+ days' },
            ]}
          />
        </div>
        {notVisited.length === 0 ? (
          <p style={styles.emptyInline}>No dealers exceed this threshold.</p>
        ) : (
          <div style={styles.alertList}>
            {notVisited.map((d) => (
              <div key={d.id} style={styles.alertRow}>
                <span style={styles.alertDealerName}>{d.name}</span>
                <span style={styles.alertDealerMeta}>
                  {d.last_visit_time ? `Last visit: ${new Date(d.last_visit_time).toLocaleDateString('en-IN')}` : 'Never visited'}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card noPadding style={{ padding: spacing.lg, marginBottom: spacing.md }}>
        <div style={styles.tabRow} className="ft-report-tabs">
          {REPORT_TABS.map((t) => (
            <button
              key={t.key}
              className={`ft-btn ${activeTab === t.key ? 'ft-btn-primary' : 'ft-btn-secondary'}`}
              style={{ height: 36, padding: '0 16px', fontSize: 13 }}
              onClick={() => setActiveTab(t.key)}
              aria-pressed={activeTab === t.key}
            >
              {t.label}
            </button>
          ))}
        </div>
      </Card>

      <FilterBar>
        <div style={styles.dateField}>
          <input type="date" style={styles.dateInput} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
        </div>
        <span style={styles.filterDash}>to</span>
        <div style={styles.dateField}>
          <input type="date" style={styles.dateInput} value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
        </div>

        <div style={styles.actionsStack}>
          <Button
            variant="success"
            icon={<Download size={14} />}
            onClick={handleExport}
            disabled={rows.length === 0}
            fullWidthMobile
          >
            Export CSV
          </Button>
          <div style={styles.repSearchRow}>
            <RepMultiSelect
              employees={employees}
              selectedIds={selectedEmployeeIds}
              onChange={setSelectedEmployeeIds}
              style={{ minWidth: 220 }}
            />
            <Button
              variant="secondary"
              icon={<RotateCcw size={14} />}
              onClick={() => {
                const d = new Date();
                d.setDate(d.getDate() - 30);
                setFrom(toDateInputValue(d));
                setTo(toDateInputValue(new Date()));
                setSelectedEmployeeIds([]);
              }}
              style={{ height: 34, padding: '0 12px', fontSize: 12 }}
            >
              Reset
            </Button>
          </div>
        </div>
      </FilterBar>

      {truncated && !error && (
        <div style={styles.truncatedBanner}>
          <AlertTriangle size={14} style={{ marginRight: 8, flexShrink: 0 }} />
          Showing the first {rows.length.toLocaleString('en-IN')} records — narrow the date range to see and export the rest.
        </div>
      )}

      <Card noPadding style={{ overflow: 'hidden' }}>
        {error ? (
          <EmptyState title="Couldn't load report" subtitle={error} onRetry={fetchReport} />
        ) : (
          <DataTable
            // Forces a remount (resetting internal sort/page state) whenever the
            // active report, date range, or rep filter changes — otherwise a
            // manager left on page 4 of a longer report would land on the same
            // page number after switching to a shorter one/different filters.
            key={`${activeTab}-${from}-${to}-${selectedEmployeeIds.join(',')}`}
            columns={columns}
            rows={rows}
            loading={loading}
            emptyTitle="No records match these filters"
            emptySubtitle="Try widening the date range or clearing the representative filter."
          />
        )}
      </Card>
    </div>
  );
}

const styles = {
  page: { padding: `${spacing.xxl}px`, maxWidth: 1920, margin: '0 auto', width: '100%', boxSizing: 'border-box' },
  alertCard: { backgroundColor: colors.warningLight, borderColor: '#FDE68A', marginBottom: spacing.xl },
  truncatedBanner: {
    display: 'flex', alignItems: 'center', backgroundColor: colors.warningLight, color: colors.warningDark,
    border: '1px solid #FDE68A', borderRadius: 12, padding: '10px 16px', marginBottom: spacing.md, fontSize: 13,
  },
  alertHeader: { display: 'flex', alignItems: 'center', marginBottom: 10, gap: 8, flexWrap: 'wrap' },
  alertTitle: { ...typography.bodyMedium, color: colors.warningDark, flex: 1 },
  emptyInline: { ...typography.body, color: colors.warningDark, margin: 0 },
  alertList: { display: 'flex', flexDirection: 'column', gap: 6 },
  alertRow: { display: 'flex', justifyContent: 'space-between', backgroundColor: colors.card, borderRadius: 8, padding: '8px 12px', fontSize: 13 },
  alertDealerName: { fontWeight: 600, color: colors.text },
  alertDealerMeta: { color: colors.textSecondary },
  tabRow: { display: 'flex', gap: 8, marginBottom: spacing.lg, flexWrap: 'wrap' },
  filterRow: { display: 'flex', gap: spacing.md, alignItems: 'center', flexWrap: 'wrap' },
  dateField: { display: 'flex', alignItems: 'center', border: `1px solid ${colors.border}`, borderRadius: 10, padding: '0 10px', height: 42 },
  dateInput: { border: 'none', outline: 'none', fontSize: 13, color: colors.text, background: 'transparent' },
  filterDash: { fontSize: 13, color: colors.textMuted },
  // Export CSV stacked above the rep-search/Reset row, right-aligned as a
  // group — Export CSV sits above Reset per the requested layout, rather than
  // the two living in separate FilterBar header/body rows as before.
  actionsStack: { display: 'flex', flexDirection: 'column', gap: spacing.sm, alignItems: 'flex-end', marginLeft: 'auto' },
  repSearchRow: { display: 'flex', gap: spacing.sm, alignItems: 'center' },
};
