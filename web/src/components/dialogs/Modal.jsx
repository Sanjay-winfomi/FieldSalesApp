import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import IconButton from '../buttons/IconButton';
import { colors, typography, spacing } from '../../theme';

/** Generic modal shell (blurred backdrop, rounded card, header + body) used
 * for add/edit forms — ConfirmationModal is the specialized confirm variant. */
export default function Modal({ open, title, subtitle, onClose, children, width = 480 }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="ft-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="ft-modal-card"
        style={{ width, maxWidth: '92vw', maxHeight: '88vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <div style={styles.header}>
          <div>
            <div id="modal-title" style={styles.title}>{title}</div>
            {!!subtitle && <div style={styles.subtitle}>{subtitle}</div>}
          </div>
          <IconButton icon={<X size={16} />} onClick={onClose} title="Close" size={32} />
        </div>
        <div style={styles.body}>{children}</div>
      </div>
    </div>
  );
}

const styles = {
  header: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    padding: `${spacing.xl}px ${spacing.xl}px ${spacing.lg}px`, borderBottom: `1px solid ${colors.border}`,
  },
  title: { ...typography.cardTitle, color: colors.text },
  subtitle: { ...typography.caption, color: colors.textSecondary, marginTop: 4 },
  body: { padding: spacing.xl, overflowY: 'auto' },
};
