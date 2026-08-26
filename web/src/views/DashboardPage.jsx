import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Users, UserCheck, Clock, CheckCircle2, Store, Route, Percent, AlertTriangle, Users2 } from 'lucide-react';
import { apiClient } from '../api';
import {
  MetricCard, EmployeeCard, EmptyState, SkeletonCard, SearchBar,
} from '../components';
import { colors, typography, spacing, radius, shadows } from '../theme';

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
  const [dealerCountError, setDealerCountError] = useState(false);

  // Dealer count isn't part of /dashboard/today — fetched once from the
  // existing /dealers endpoint purely to show a real "Total dealers" metric
  // instead of fabricating one.
  const fetchDealerCount = useCallback(() => {
    setDealerCountError(false);
    apiClient.get('/dealers')
      .then((res) => setDealerCount(res.data.dealers?.length ?? null))
      .catch(() => setDealerCountError(true));
  }, []);

  useEffect(() => {
    fetchDealerCount();
  }, [fetchDealerCount]);

  const stats = useMemo(() => ({
    logged_in: reps.filter((r) => r.status === 'logged_in').length,
    not_logged_in: reps.filter((r) => r.status === 'not_logged_in').length,
    day_ended: reps.filter((r) => r.status === 'day_ended').length,
  }), [reps]);

  const totalDistanceToday = useMemo(
    () => reps.reduce((sum, r) => sum + (r.total_distance_km || 0), 0),
    [reps]
  );

  const attendancePct = reps.length > 0
    ? Math.round(((stats.logged_in + stats.day_ended) / reps.length) * 100)
    : 0;

  const [repSearch, setRepSearch] = useState('');
  const filteredReps = useMemo(() => {
    const q = repSearch.trim().toLowerCase();
    if (!q) return reps;
    return reps.filter((r) => r.name?.toLowerCase().includes(q) || r.region?.toLowerCase().includes(q));
  }, [reps, repSearch]);

  return (
    <div style={styles.page} className="ft-page">
      <div style={styles.hero}>
        <div style={styles.heroGlow} aria-hidden="true" />
        <div style={styles.heroSheen} aria-hidden="true" />
        <div style={styles.heroContent}>
          <h1 style={styles.title}>Field Team — Today</h1>
          <p style={styles.subtitle}>
            {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
        </div>
      </div>

      <div style={styles.metricsGrid} className="ft-stagger">
        <MetricCard icon={<Users />} value={reps.length} label="Total employees" tone="primary" />
        <MetricCard icon={<UserCheck />} value={stats.logged_in} label="Logged in" tone="success" />
        <MetricCard icon={<Clock />} value={stats.not_logged_in} label="Pending login" tone="warning" />
        <MetricCard icon={<CheckCircle2 />} value={stats.day_ended} label="Day ended" tone="neutral" />
        <MetricCard
          icon={<Store />}
          value={dealerCountError ? '—' : (dealerCount ?? '—')}
          label="Total dealers"
          subtitle={dealerCountError ? 'Failed to load — click to retry' : undefined}
          tone={dealerCountError ? 'danger' : 'primary'}
          onClick={dealerCountError ? fetchDealerCount : undefined}
        />
        <MetricCard icon={<Route />} value={`${totalDistanceToday.toFixed(1)} km`} label="Distance today" tone="warning" />
        <MetricCard icon={<Percent />} value={`${attendancePct}%`} label="Attendance today" tone="success" />
      </div>

      {error && (
        <div style={styles.errorBanner}>
          <AlertTriangle size={16} style={{ marginRight: 8, flexShrink: 0 }} />
          {error}
        </div>
      )}

      <div className="ft-dashboard-left">
        <div style={styles.columnHeaderRow}>
          <div style={styles.columnHeader}>
            <Users2 size={14} color={colors.textSecondary} />
            Field representatives ({reps.length})
          </div>
          {reps.length > 0 && (
            <SearchBar
              value={repSearch}
              onChange={setRepSearch}
              placeholder="Search by name or region..."
              style={{ maxWidth: 280 }}
            />
          )}
        </div>

        <div style={styles.repGrid} className="ft-stagger">
          {loading && reps.length === 0 ? (
            Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
          ) : reps.length === 0 ? (
            <div style={{ gridColumn: '1 / -1' }}>
              <EmptyState title="No representatives yet" subtitle="Field reps will appear here once they're added." />
            </div>
          ) : filteredReps.length === 0 ? (
            <div style={{ gridColumn: '1 / -1' }}>
              <EmptyState title="No representative found" subtitle="Try a different name or region." />
            </div>
          ) : (
            filteredReps.map((rep) => (
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
    </div>
  );
}

const styles = {
  page: { padding: `${spacing.xxl}px`, maxWidth: 1920, margin: '0 auto', width: '100%', boxSizing: 'border-box' },
  hero: {
    position: 'relative', overflow: 'hidden',
    background: colors.neutralBg,
    backdropFilter: 'blur(20px) saturate(120%)',
    WebkitBackdropFilter: 'blur(20px) saturate(120%)',
    border: `1px solid ${colors.neutralBorder}`,
    borderRadius: radius.card, padding: `${spacing.xxl}px ${spacing.xxl}px`,
    marginBottom: spacing.xl, boxShadow: '0 8px 32px rgba(15,23,42,0.10)',
  },
  heroGlow: {
    position: 'absolute', top: -60, right: -40, width: 220, height: 220, borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0) 70%)',
    pointerEvents: 'none',
  },
  heroSheen: {
    position: 'absolute', inset: 0,
    background: 'linear-gradient(180deg, rgba(255,255,255,0.28) 0%, rgba(255,255,255,0) 55%)',
    pointerEvents: 'none',
  },
  heroContent: { position: 'relative' },
  title: { ...typography.dashboardTitle, color: colors.text },
  subtitle: { ...typography.body, color: 'rgba(31,41,55,0.75)', marginTop: 4 },
  metricsGrid: {
    display: 'grid',
    // 150px (not 190px) so all 7 cards hold one row across the zoom levels
    // people actually use (50%-125%) instead of wrapping to a 5+2 split the
    // moment the browser's CSS-pixel viewport narrows a bit — auto-fit still
    // wraps gracefully at extreme zoom, it just needs a smaller floor to do
    // that at 7 columns instead of 5.
    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
    gap: spacing.lg,
    marginBottom: spacing.xl,
  },
  errorBanner: {
    display: 'flex', alignItems: 'center', backgroundColor: colors.dangerLight, color: colors.dangerDark,
    border: `1px solid #FECACA`, borderRadius: 12, padding: '12px 16px', marginBottom: spacing.lg, fontSize: 14,
  },
  columnHeaderRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    flexWrap: 'wrap', gap: spacing.md, marginBottom: spacing.md,
  },
  columnHeader: { display: 'flex', alignItems: 'center', gap: 8, ...typography.bodyMedium, color: colors.textSecondary },
  repGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
    gap: spacing.lg,
    alignContent: 'start',
  },
};
