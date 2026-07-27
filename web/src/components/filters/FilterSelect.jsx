import React from 'react';
import { ChevronDown } from 'lucide-react';
import { colors } from '../../theme';

/** A labeled dropdown filter — consistent chrome for status/region/role filters. */
export default function FilterSelect({ label, value, onChange, options, style, ariaLabel }) {
  return (
    <div style={{ position: 'relative', minWidth: 160, ...style }}>
      <select
        className="ft-input"
        style={{ paddingRight: 34, appearance: 'none', cursor: 'pointer' }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel || label}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      <ChevronDown size={15} color={colors.textMuted} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
    </div>
  );
}
