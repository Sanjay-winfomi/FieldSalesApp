import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { colors, typography } from '../../theme';

export default function Pagination({ page, pageCount, totalItems, pageSize, onPageChange }) {
  if (pageCount <= 1) return null;

  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalItems);

  return (
    <div style={styles.wrap}>
      <span style={styles.summary}>
        Showing <strong>{start}–{end}</strong> of <strong>{totalItems}</strong>
      </span>
      <div style={styles.controls}>
        <button
          type="button"
          className="ft-icon-btn"
          style={styles.navBtn}
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
        >
          <ChevronLeft size={16} />
        </button>
        <span style={styles.pageLabel}>Page {page} of {pageCount}</span>
        <button
          type="button"
          className="ft-icon-btn"
          style={styles.navBtn}
          onClick={() => onPageChange(page + 1)}
          disabled={page >= pageCount}
          aria-label="Next page"
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

const styles = {
  wrap: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', flexWrap: 'wrap', gap: 12 },
  summary: { ...typography.caption, color: colors.textSecondary },
  controls: { display: 'flex', alignItems: 'center', gap: 10 },
  navBtn: { width: 32, height: 32 },
  pageLabel: { ...typography.caption, color: colors.textSecondary, fontWeight: 600, minWidth: 90, textAlign: 'center' },
};
