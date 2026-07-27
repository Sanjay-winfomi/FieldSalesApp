import React from 'react';
import { Inbox, RotateCcw } from 'lucide-react';
import Button from './buttons/Button';
import { colors, typography } from '../theme';

/**
 * Consistent "nothing here" / error-retry state — icon, headline, optional
 * supporting text, optional retry action.
 */
export default function EmptyState({ icon, title = 'Nothing to show', subtitle, onRetry, retryLabel = 'Retry' }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '56px 24px', textAlign: 'center' }}>
      <div style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: colors.hover, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 16 }}>
        {icon || <Inbox size={24} color={colors.textMuted} />}
      </div>
      <div style={{ ...typography.cardTitle, color: colors.text }}>{title}</div>
      {!!subtitle && <div style={{ ...typography.body, color: colors.textSecondary, marginTop: 6, maxWidth: 360 }}>{subtitle}</div>}
      {onRetry && (
        <Button variant="secondary" icon={<RotateCcw size={14} />} onClick={onRetry} style={{ marginTop: 20 }}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
