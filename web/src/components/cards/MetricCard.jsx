import React from 'react';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';
import Card from './Card';
import { colors, typography, spacing, radius } from '../../theme';

const TONES = {
  primary: { bg: colors.primaryLight, iconColor: colors.primary },
  success: { bg: colors.successLight, iconColor: colors.successDark },
  warning: { bg: colors.warningLight, iconColor: colors.warningDark },
  danger: { bg: colors.dangerLight, iconColor: colors.dangerDark },
  neutral: { bg: colors.hover, iconColor: colors.textSecondary },
};

/**
 * A single top-of-page metric tile (icon, value, subtitle, optional trend) —
 * used across the Dashboard and Reports summary rows.
 * `trend` is a plain number (e.g. +4 or -2); omit it when there's no real
 * period-over-period comparison to show rather than fabricating one.
 */
export default function MetricCard({ icon, value, label, subtitle, tone = 'primary', trend, onClick }) {
  const t = TONES[tone] || TONES.primary;
  const trendUp = typeof trend === 'number' && trend >= 0;

  return (
    <Card hoverable onClick={onClick} style={{ ...styles.card, ...(onClick ? { cursor: 'pointer' } : {}) }}>
      <div style={{ ...styles.glow, background: t.iconColor }} aria-hidden="true" />
      <div style={styles.row}>
        <div style={{ ...styles.iconWrap, backgroundColor: t.bg }}>
          {icon && React.cloneElement(icon, { size: 20, color: t.iconColor })}
        </div>
        {typeof trend === 'number' && (
          <span style={{ ...styles.trend, color: trendUp ? colors.successDark : colors.dangerDark }}>
            {trendUp ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
            {Math.abs(trend)}%
          </span>
        )}
      </div>
      <div style={styles.value}>{value}</div>
      <div style={styles.label}>{label}</div>
      {!!subtitle && <div style={styles.subtitle}>{subtitle}</div>}
    </Card>
  );
}

const styles = {
  card: { minWidth: 0, position: 'relative', overflow: 'hidden' },
  glow: {
    position: 'absolute', top: -30, right: -30, width: 110, height: 110, borderRadius: '50%',
    opacity: 0.10, pointerEvents: 'none',
  },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.lg },
  iconWrap: {
    width: 44, height: 44, borderRadius: radius.pill, display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  trend: { display: 'flex', alignItems: 'center', gap: 2, fontSize: 12, fontWeight: 700 },
  value: { ...typography.sectionTitle, fontSize: 28, color: colors.text, lineHeight: 1.15, letterSpacing: '-0.02em' },
  label: { ...typography.body, color: colors.textSecondary, marginTop: 4 },
  subtitle: { ...typography.caption, color: colors.textMuted, marginTop: 2 },
};
