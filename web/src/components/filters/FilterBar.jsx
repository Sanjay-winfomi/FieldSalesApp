import React, { useState } from 'react';
import { SlidersHorizontal, RotateCcw, ChevronDown } from 'lucide-react';
import Card from '../cards/Card';
import Button from '../buttons/Button';
import { colors, spacing, typography } from '../../theme';

/**
 * Responsive filter bar shell — always shows its children on desktop; below
 * ~860px it collapses behind a "Filters" toggle so the bar doesn't crowd out
 * the page on small screens.
 */
export default function FilterBar({ children, onReset, title = 'Filters' }) {
  const [open, setOpen] = useState(false);

  return (
    <Card noPadding style={{ padding: spacing.lg, marginBottom: spacing.xl }}>
      <div className="ft-filterbar-header" style={styles.header}>
        <div style={styles.titleRow}>
          <SlidersHorizontal size={16} color={colors.textSecondary} />
          <span style={styles.title}>{title}</span>
        </div>
        <div style={styles.headerActions}>
          {onReset && (
            <Button variant="secondary" icon={<RotateCcw size={14} />} onClick={onReset} style={{ height: 34, padding: '0 12px', fontSize: 12 }}>
              Reset
            </Button>
          )}
          <button
            type="button"
            className="ft-filterbar-toggle"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? 'Collapse filters' : 'Expand filters'}
            style={styles.toggleBtn}
          >
            <ChevronDown size={16} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 180ms ease' }} />
          </button>
        </div>
      </div>

      <div className={`ft-filterbar-body ${open ? 'ft-filterbar-body-open' : ''}`} style={styles.bodyGap}>
        {children}
      </div>
    </Card>
  );
}

const styles = {
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  titleRow: { display: 'flex', alignItems: 'center', gap: 8 },
  title: { ...typography.bodyMedium, color: colors.text },
  headerActions: { display: 'flex', alignItems: 'center', gap: spacing.sm },
  toggleBtn: {
    background: 'none', border: 'none', color: colors.textSecondary,
    width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 8,
  },
  bodyGap: { gap: spacing.md, alignItems: 'center', flexWrap: 'wrap', marginTop: spacing.lg },
};
