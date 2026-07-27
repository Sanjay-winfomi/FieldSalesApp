import React, { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import Button from '../buttons/Button';
import { colors, typography, spacing } from '../../theme';

/**
 * Modern confirm dialog — blurred backdrop, rounded card, primary/secondary
 * actions, optional danger tone and loading state on the confirm button.
 */
export default function ConfirmationModal({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onCancel?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="ft-modal-backdrop" onClick={onCancel} role="presentation">
      <div
        className="ft-modal-card"
        style={{ width: 400, maxWidth: '90vw', padding: spacing.xxl }}
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: spacing.lg }}>
          {danger && (
            <div style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.dangerLight, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <AlertTriangle size={18} color={colors.dangerDark} />
            </div>
          )}
          <div>
            <div id="confirm-modal-title" style={{ ...typography.cardTitle, color: colors.text }}>{title}</div>
            {!!message && <div style={{ ...typography.body, color: colors.textSecondary, marginTop: 6 }}>{message}</div>}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <Button variant="secondary" onClick={onCancel} disabled={loading}>{cancelLabel}</Button>
          <Button variant={danger ? 'danger-solid' : 'primary'} onClick={onConfirm} loading={loading}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}
