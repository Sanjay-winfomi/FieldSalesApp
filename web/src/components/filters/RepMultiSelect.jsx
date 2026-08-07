import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, ChevronDown, Check, X } from 'lucide-react';
import { colors, typography, shadows } from '../../theme';

/**
 * Searchable multi-select for filtering reports by representative — replaces
 * the old single-select FilterSelect for this one use. No selection means
 * "whole company" (unchanged default), matching how the plain employee_id
 * filter worked before.
 */
export default function RepMultiSelect({ employees, selectedIds, onChange, style }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapperRef = useRef(null);

  useEffect(() => {
    const onClickOutside = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((e) => e.name.toLowerCase().includes(q));
  }, [employees, search]);

  const triggerLabel = selectedIds.length === 0
    ? 'All representatives'
    : selectedIds.length === 1
      ? (employees.find((e) => e.id === selectedIds[0])?.name || '1 Representative Selected')
      : `${selectedIds.length} Representatives Selected`;

  const toggle = (id) => {
    onChange(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
  };

  return (
    <div ref={wrapperRef} style={{ position: 'relative', minWidth: 220, ...style }}>
      <button
        type="button"
        className="ft-input"
        style={styles.trigger}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span style={styles.triggerLabel}>{triggerLabel}</span>
        <ChevronDown size={15} color={colors.textMuted} style={{ flexShrink: 0 }} />
      </button>

      {open && (
        <div style={styles.panel} className="ft-scale-in" role="listbox">
          <div style={styles.searchRow}>
            <Search size={14} color={colors.textMuted} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)' }} />
            <input
              type="text"
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search Representative..."
              aria-label="Search Representative"
              style={styles.searchInput}
            />
            {!!search && (
              <button type="button" onClick={() => setSearch('')} aria-label="Clear search" style={styles.clearSearchBtn}>
                <X size={14} />
              </button>
            )}
          </div>

          <div style={styles.actionsRow}>
            <button
              type="button"
              style={styles.actionLink}
              // Selects the currently-visible (search-filtered) reps, added
              // to whatever was already selected — not every rep in the
              // company regardless of the active search, which would
              // silently select reps the user can't even see right now.
              onClick={() => onChange([...new Set([...selectedIds, ...filtered.map((e) => e.id)])])}
            >
              Select All
            </button>
            <button type="button" style={styles.actionLink} onClick={() => onChange([])}>
              Clear Selection
            </button>
          </div>

          <div style={styles.list}>
            {filtered.length === 0 ? (
              <div style={styles.emptyState}>No representative found.</div>
            ) : (
              filtered.map((e) => {
                const checked = selectedIds.includes(e.id);
                return (
                  <button
                    key={e.id}
                    type="button"
                    role="option"
                    aria-selected={checked}
                    style={styles.option}
                    onClick={() => toggle(e.id)}
                  >
                    <span style={{ ...styles.checkbox, ...(checked ? styles.checkboxChecked : null) }}>
                      {checked && <Check size={12} color="#FFFFFF" />}
                    </span>
                    <span style={styles.optionLabel}>{e.name}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  trigger: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
    cursor: 'pointer', textAlign: 'left', width: '100%',
  },
  triggerLabel: { ...typography.body, fontSize: 13, color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  panel: {
    position: 'absolute', top: 'calc(100% + 6px)', left: 0, width: 300, maxWidth: '90vw',
    backgroundColor: colors.card, border: `1px solid ${colors.border}`, borderRadius: 12,
    boxShadow: shadows.dropdown, zIndex: 200, overflow: 'hidden',
  },
  searchRow: { position: 'relative', padding: 10, borderBottom: `1px solid ${colors.border}` },
  searchInput: {
    width: '100%', height: 36, borderRadius: 8, border: `1px solid ${colors.border}`,
    padding: '0 32px', fontSize: 13, outline: 'none', boxSizing: 'border-box',
  },
  clearSearchBtn: {
    position: 'absolute', right: 16, top: '50%', transform: 'translateY(-50%)',
    background: 'none', border: 'none', display: 'flex', color: colors.textMuted, padding: 2, cursor: 'pointer',
  },
  actionsRow: { display: 'flex', gap: 14, padding: '8px 12px', borderBottom: `1px solid ${colors.border}` },
  actionLink: {
    background: 'none', border: 'none', padding: 0, color: colors.primary, fontSize: 12, fontWeight: 600, cursor: 'pointer',
  },
  list: { maxHeight: 240, overflowY: 'auto', padding: 6 },
  emptyState: { padding: '16px 10px', textAlign: 'center', fontSize: 13, color: colors.textMuted },
  option: {
    display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', borderRadius: 8,
    border: 'none', background: 'none', textAlign: 'left', cursor: 'pointer', fontSize: 13, color: colors.text,
  },
  checkbox: {
    width: 16, height: 16, borderRadius: 4, border: `1.5px solid ${colors.border}`, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card,
  },
  checkboxChecked: { backgroundColor: colors.primary, borderColor: colors.primary },
  optionLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
};
