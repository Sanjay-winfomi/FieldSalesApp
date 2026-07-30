import React from 'react';
import { Store, Route, ChevronRight, AlertTriangle } from 'lucide-react';
import Card from './Card';
import StatusBadge from '../StatusBadge';
import { colors, typography, spacing } from '../../theme';

const STATUS_META = {
  checked_in: { label: 'Logged in', tone: 'success', dot: colors.success },
  day_ended: { label: 'Day ended', tone: 'warning', dot: colors.warning },
  not_checked_in: { label: 'Not logged in', tone: 'neutral', dot: colors.textMuted },
};

function initials(name) {
  if (!name) return '?';
  return name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}

/**
 * One rep in the dashboard's live list — avatar, name/role/region, current
 * activity, visit/distance stats, and a status badge with a live dot for
 * reps currently checked in.
 */
export default function EmployeeCard({ rep, onViewDetails, timestampLabel }) {
  const meta = STATUS_META[rep.status] || STATUS_META.not_checked_in;
  const isLive = rep.status === 'checked_in';

  return (
    <Card hoverable onClick={onViewDetails} style={styles.card} aria-label={`View details for ${rep.name}`}>
      <div style={styles.topRow}>
        <div style={styles.identity}>
          <div style={styles.avatarWrap}>
            <div style={styles.avatar}>{initials(rep.name)}</div>
            {isLive && <span style={styles.liveDot} aria-label="Live" />}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={styles.name}>{rep.name}</div>
            <div style={styles.metaLine}>
              {rep.region && <span>{rep.region}</span>}
            </div>
          </div>
        </div>
        <StatusBadge label={meta.label} tone={meta.tone} />
      </div>

      <div style={styles.activityRow}>{rep.last_activity}</div>

      {rep.needs_logout_alert && (
        <div style={styles.alertBanner}>
          <AlertTriangle size={13} style={{ marginRight: 6, flexShrink: 0 }} />
          Outside dealer radius repeatedly — needs to log out
        </div>
      )}

      <div style={styles.statsRow}>
        <div style={styles.stat}>
          <Store size={13} color={colors.textMuted} />
          <span>{rep.visits_count} visit{rep.visits_count !== 1 ? 's' : ''}</span>
        </div>
        <div style={styles.stat}>
          <Route size={13} color={colors.textMuted} />
          <span>{(rep.total_distance_km || 0).toFixed(1)} km</span>
        </div>
        {timestampLabel && <div style={styles.stat}>{timestampLabel}</div>}
      </div>

      <div style={styles.footer}>
        <span style={styles.viewDetails}>View details</span>
        <ChevronRight size={16} color={colors.textMuted} />
      </div>
    </Card>
  );
}

const styles = {
  card: { marginBottom: 0 },
  topRow: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md },
  identity: { display: 'flex', alignItems: 'center', gap: spacing.md, minWidth: 0 },
  avatarWrap: { position: 'relative', flexShrink: 0 },
  avatar: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: colors.avatarBg, color: colors.avatarText,
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700,
  },
  liveDot: {
    position: 'absolute', bottom: -1, right: -1, width: 11, height: 11, borderRadius: 6,
    backgroundColor: colors.success, border: '2px solid #FFFFFF',
  },
  name: { ...typography.cardTitle, fontSize: 15, color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  metaLine: { ...typography.caption, color: colors.textMuted, marginTop: 2 },
  activityRow: { ...typography.body, color: colors.textSecondary, marginTop: spacing.md, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  alertBanner: {
    display: 'flex', alignItems: 'center', backgroundColor: colors.dangerLight, color: colors.dangerDark,
    border: '1px solid #FECACA', borderRadius: 8, padding: '6px 10px', marginTop: spacing.sm, fontSize: 11.5, fontWeight: 600,
  },
  statsRow: { display: 'flex', gap: spacing.lg, marginTop: spacing.sm, flexWrap: 'wrap' },
  stat: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: colors.textMuted },
  footer: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.md, paddingTop: spacing.md, borderTop: `1px solid ${colors.border}` },
  viewDetails: { fontSize: 12, fontWeight: 600, color: colors.primary },
};
