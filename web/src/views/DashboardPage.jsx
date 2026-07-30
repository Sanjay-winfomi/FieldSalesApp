import React, { useState, useEffect, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { Users, UserCheck, Clock, CheckCircle2, Store, Route, Percent, AlertTriangle, Users2, Flame } from 'lucide-react';
import { apiClient } from '../api';
import {
  MetricCard, EmployeeCard, EmptyState, SkeletonCard, Button, LoadingCard,
} from '../components';
import { colors, typography, spacing } from '../theme';

// Code-split out of the main bundle: RepHeatMap pulls in @react-google-maps/api
// and deck.gl, which are heavy (~170kB+ gzipped combined) and only ever used
// if a manager actually clicks "View Heat Map". `ssr: false` because it reads
// `window.google`/WebGL, which don't exist during server rendering.
const RepHeatMap = dynamic(() => import('../components/heatmap/RepHeatMap'), {
  ssr: false,
  loading: () => <LoadingCard message="Loading heat map module..." />,
});

function formatTimestamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.round(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins} min ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs} hr ago`;
  return d.toLocaleDateString('en-IN');
}

export default function DashboardPage({
  reps, loading, error, onSelectRep,
}) {
  const [dealerCount, setDealerCount] = useState(null);

  // Dealer count isn't part of /dashboard/today — fetched once from the
  // existing /dealers endpoint purely to show a real "Total dealers" metric
  // instead of fabricating one.
  useEffect(() => {
    apiClient.get('/dealers').then((res) => setDealerCount(res.data.dealers?.length ?? null)).catch(() => {});
  }, []);

  const stats = useMemo(() => ({
    checked_in: reps.filter((r) => r.status === 'checked_in').length,
    not_checked_in: reps.filter((r) => r.status === 'not_checked_in').length,
    day_ended: reps.filter((r) => r.status === 'day_ended').length,
  }), [reps]);

  const totalDistanceToday = useMemo(
    () => reps.reduce((sum, r) => sum + (r.total_distance_km || 0), 0),
    [reps]
  );

  const attendancePct = reps.length > 0
    ? Math.round(((stats.checked_in + stats.day_ended) / reps.length) * 100)
    : 0;

  const repsNeedingLogout = useMemo(
    () => reps.filter((r) => r.needs_logout_alert),
    [reps]
  );

  // Google Maps must never load until the manager explicitly asks for it —
  // `heatMapMounted` flips false→true once, on the first click, and never
  // back, so the map component (and its Google Maps script load) is created
  // exactly once no matter how many times the button is pressed afterward.
  // `heatMapVisible` just toggles a CSS show/hide on that already-mounted
  // panel, so re-opening it never recreates the map instance.
  const [heatMapMounted, setHeatMapMounted] = useState(false);
  const [heatMapVisible, setHeatMapVisible] = useState(false);

  const handleToggleHeatMap = () => {
    if (!heatMapMounted) setHeatMapMounted(true);
    setHeatMapVisible((visible) => !visible);
  };

  return (
    <div style={styles.page} className="ft-page">
      <div style={styles.headerRow}>
        <div>
          <h1 style={styles.title}>Field team — today</h1>
          <p style={styles.subtitle}>
            {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
        </div>
        <Button variant="secondary" icon={<Flame size={15} />} onClick={handleToggleHeatMap}>
          {heatMapVisible ? 'Hide Heat Map' : 'View Heat Map'}
        </Button>
      </div>

      <div style={styles.metricsGrid}>
        <MetricCard icon={<Users />} value={reps.length} label="Total employees" tone="primary" />
        <MetricCard icon={<UserCheck />} value={stats.checked_in} label="Logged in" tone="success" />
        <MetricCard icon={<Clock />} value={stats.not_checked_in} label="Pending login" tone="warning" />
        <MetricCard icon={<CheckCircle2 />} value={stats.day_ended} label="Day ended" tone="neutral" />
        <MetricCard icon={<Store />} value={dealerCount ?? '—'} label="Total dealers" tone="primary" />
        <MetricCard icon={<Route />} value={`${totalDistanceToday.toFixed(1)} km`} label="Distance today" tone="warning" />
        <MetricCard icon={<Percent />} value={`${attendancePct}%`} label="Attendance today" tone="success" />
      </div>

      {error && (
        <div style={styles.errorBanner}>
          <AlertTriangle size={16} style={{ marginRight: 8, flexShrink: 0 }} />
          {error}
        </div>
      )}

      {repsNeedingLogout.length > 0 && (
        <div style={styles.errorBanner}>
          <AlertTriangle size={16} style={{ marginRight: 8, flexShrink: 0 }} />
          {repsNeedingLogout.map((r) => r.name).join(', ')}
          {repsNeedingLogout.length === 1 ? ' has' : ' have'} been outside the dealer radius repeatedly and should log out.
        </div>
      )}

      <div className="ft-dashboard-left">
        <div style={styles.columnHeader}>
          <Users2 size={14} color={colors.textSecondary} />
          Field representatives ({reps.length})
        </div>

        <div style={styles.repGrid}>
          {loading && reps.length === 0 ? (
            Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
          ) : reps.length === 0 ? (
            <div style={{ gridColumn: '1 / -1' }}>
              <EmptyState title="No representatives yet" subtitle="Field reps will appear here once they're added." />
            </div>
          ) : (
            reps.map((rep) => (
              <EmployeeCard
                key={rep.id}
                rep={rep}
                onViewDetails={() => onSelectRep(rep.id)}
                timestampLabel={formatTimestamp(rep.last_updated)}
              />
            ))
          )}
        </div>
      </div>

      {heatMapMounted && (
        <div style={{ display: heatMapVisible ? 'block' : 'none' }}>
          <RepHeatMap />
        </div>
      )}
    </div>
  );
}

const styles = {
  page: { padding: `${spacing.xxl}px`, maxWidth: 1920, margin: '0 auto', width: '100%', boxSizing: 'border-box' },
  headerRow: {
    marginBottom: spacing.xl, display: 'flex', alignItems: 'flex-start',
    justifyContent: 'space-between', flexWrap: 'wrap', gap: spacing.md,
  },
  title: { ...typography.dashboardTitle, color: colors.text },
  subtitle: { ...typography.body, color: colors.textSecondary, marginTop: 4 },
  metricsGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
    gap: spacing.lg,
    marginBottom: spacing.xl,
  },
  errorBanner: {
    display: 'flex', alignItems: 'center', backgroundColor: colors.dangerLight, color: colors.dangerDark,
    border: `1px solid #FECACA`, borderRadius: 12, padding: '12px 16px', marginBottom: spacing.lg, fontSize: 14,
  },
  columnHeader: { display: 'flex', alignItems: 'center', gap: 8, ...typography.bodyMedium, color: colors.textSecondary, marginBottom: spacing.md },
  repGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
    gap: spacing.lg,
    alignContent: 'start',
  },
};
