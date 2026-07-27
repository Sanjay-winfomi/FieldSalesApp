import React from 'react';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';
import Card from './Card';
import { colors, typography, spacing } from '../../theme';

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
export default function MetricCard({ icon, value, label, subtitle, tone = 'primary', trend }) {
  const t = TONES[tone] || TONES.primary;
  const trendUp = typeof trend === 'number' && trend >= 0;

  return (
    <Card hoverable style={styles.card}>
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
  card: { minWidth: 0 },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  iconWrap: {
    width: 40, height: 40, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  trend: { display: 'flex', alignItems: 'center', gap: 2, fontSize: 12, fontWeight: 700 },
  value: { ...typography.sectionTitle, fontSize: 26, color: colors.text, lineHeight: 1.2 },
  label: { ...typography.body, color: colors.textSecondary, marginTop: 4 },
  subtitle: { ...typography.caption, color: colors.textMuted, marginTop: 2 },
};
