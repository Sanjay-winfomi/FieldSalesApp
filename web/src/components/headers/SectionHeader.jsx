import React from 'react';
import { colors, typography, spacing } from '../../theme';

export default function SectionHeader({ title, subtitle, action }) {
  return (
    <div style={styles.wrap}>
      <div style={styles.accentBar} aria-hidden="true" />
      <div style={styles.row}>
        <div>
          <h2 style={styles.title}>{title}</h2>
          {!!subtitle && <p style={styles.subtitle}>{subtitle}</p>}
        </div>
        {action}
      </div>
    </div>
  );
}

const styles = {
  wrap: { position: 'relative', paddingLeft: 18, marginBottom: spacing.xl },
  accentBar: {
    position: 'absolute', left: 0, top: 3, bottom: 3, width: 5, borderRadius: 999,
    background: colors.gradientPrimary,
  },
  row: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.md, flexWrap: 'wrap' },
  title: { ...typography.sectionTitle, fontSize: 26, color: colors.text, letterSpacing: '-0.02em' },
  subtitle: { ...typography.body, color: colors.textSecondary, marginTop: 4 },
};
