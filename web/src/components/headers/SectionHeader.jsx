import React from 'react';
import { colors, typography, spacing } from '../../theme';

export default function SectionHeader({ title, subtitle, action }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: spacing.lg, gap: spacing.md, flexWrap: 'wrap' }}>
      <div>
        <h2 style={{ ...typography.sectionTitle, color: colors.text }}>{title}</h2>
        {!!subtitle && <p style={{ ...typography.body, color: colors.textSecondary, marginTop: 4 }}>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
