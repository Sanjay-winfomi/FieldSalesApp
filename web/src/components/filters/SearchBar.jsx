import React from 'react';
import { Search, X } from 'lucide-react';
import { colors } from '../../theme';

export default function SearchBar({ value, onChange, placeholder = 'Search', style, ariaLabel }) {
  return (
    <div style={{ position: 'relative', ...style }}>
      <Search size={16} color={colors.textMuted} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
      <input
        type="text"
        className="ft-input"
        style={{ paddingLeft: 38, paddingRight: value ? 34 : 14 }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel || placeholder}
      />
      {!!value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label="Clear search"
          style={{
            position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
            background: 'none', border: 'none', display: 'flex', color: colors.textMuted, padding: 4,
          }}
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}
