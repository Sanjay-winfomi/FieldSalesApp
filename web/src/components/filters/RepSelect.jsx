import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, ChevronDown, Check } from 'lucide-react';
import { colors, typography, shadows } from '../../theme';

/**
 * Single-select searchable representative picker — same search/panel chrome
 * as RepMultiSelect, but for pages that need exactly one rep chosen (e.g.
 * the Dealer Assignments editor) rather than a multi-select filter. Kept as
 * its own component instead of adding a "single" mode to RepMultiSelect, so
 * that existing usage of RepMultiSelect is untouched.
 */
export default function RepSelect({ employees, selectedId, onChange, placeholder = 'Select a representative', style }) {
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

  const selected = employees.find((e) => e.id === selectedId);

  const handleSelect = (id) => {
    onChange(id);
    setOpen(false);
    setSearch('');
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
        <span style={{ ...styles.triggerLabel, color: selected ? colors.text : colors.textMuted }}>
          {selected ? selected.name : placeholder}
        </span>
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
          </div>

          <div style={styles.list}>
            {filtered.length === 0 ? (
              <div style={styles.emptyState}>No representative found.</div>
            ) : (
              filtered.map((e) => {
                const checked = e.id === selectedId;
                return (
                  <button
                    key={e.id}
                    type="button"
                    role="option"
                    aria-selected={checked}
                    style={styles.option}
                    onClick={() => handleSelect(e.id)}
                  >
                    <span style={styles.optionLabel}>{e.name}</span>
                    {checked && <Check size={14} color={colors.primary} />}
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
  triggerLabel: { ...typography.body, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  panel: {
    position: 'absolute', top: 'calc(100% + 6px)', left: 0, width: 300, maxWidth: '90vw',
    backgroundColor: colors.card, border: `1px solid ${colors.border}`, borderRadius: 12,
    boxShadow: shadows.dropdown, zIndex: 200, overflow: 'hidden',
  },
  searchRow: { position: 'relative', padding: 10, borderBottom: `1px solid ${colors.border}` },
  searchInput: {
    width: '100%', height: 36, borderRadius: 8, border: `1px solid ${colors.border}`,
    padding: '0 12px 0 32px', fontSize: 13, outline: 'none', boxSizing: 'border-box',
  },
  list: { maxHeight: 240, overflowY: 'auto', padding: 6 },
  emptyState: { padding: '16px 10px', textAlign: 'center', fontSize: 13, color: colors.textMuted },
  option: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, width: '100%',
    padding: '8px 10px', borderRadius: 8, border: 'none', background: 'none', textAlign: 'left',
    cursor: 'pointer', fontSize: 13, color: colors.text,
  },
  optionLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
};
