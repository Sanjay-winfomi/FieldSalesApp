import React from 'react';
import { colors, radius } from '../theme';

const TONES = {
  success: { bg: colors.successLight, border: '#BBF7D0', text: colors.successDark },
  warning: { bg: colors.warningLight, border: '#FDE68A', text: colors.warningDark },
  danger: { bg: colors.dangerLight, border: '#FECACA', text: colors.dangerDark },
  neutral: { bg: colors.neutralBg, border: colors.neutralBorder, text: colors.textSecondary },
  primary: { bg: colors.primaryLight, border: '#CFEAD9', text: colors.primary },
};

/** A small pill used for statuses, roles, regions — consistent everywhere. */
export default function StatusBadge({ label, tone = 'neutral', icon }) {
  const t = TONES[tone] || TONES.neutral;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 10px',
        borderRadius: radius.pill,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        backgroundColor: t.bg,
        border: `1px solid ${t.border}`,
        color: t.text,
      }}
    >
      {icon}
      {label}
    </span>
  );
}
