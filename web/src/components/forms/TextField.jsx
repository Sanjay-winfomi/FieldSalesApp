import React, { useState } from 'react';
import { colors, typography } from '../../theme';

/**
 * Floating-label text input — label sits inside the field until focused or
 * filled, then floats above the border. Supports error/success states.
 */
export default function TextField({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  error,
  success,
  required,
  disabled,
  minLength,
  style,
  ...rest
}) {
  const [focused, setFocused] = useState(false);
  const floated = focused || (value != null && value !== '');

  const borderColor = error ? colors.danger : success ? colors.success : focused ? colors.primary : colors.border;

  return (
    <div style={{ position: 'relative', ...style }}>
      <div style={{ position: 'relative' }}>
        {label && (
          <label
            style={{
              position: 'absolute',
              left: 14,
              top: floated ? -8 : '50%',
              transform: floated ? 'none' : 'translateY(-50%)',
              fontSize: floated ? 11 : 14,
              fontWeight: floated ? 600 : 400,
              color: focused ? colors.primary : colors.textSecondary,
              backgroundColor: colors.card,
              padding: floated ? '0 4px' : 0,
              transition: 'all 120ms ease',
              pointerEvents: 'none',
            }}
          >
            {label}{required && <span style={{ color: colors.danger }}> *</span>}
          </label>
        )}
        <input
          type={type}
          className={`ft-input ${error ? 'ft-input-error' : ''}`}
          style={{ borderColor, height: 46 }}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={focused ? placeholder : ''}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          disabled={disabled}
          minLength={minLength}
          aria-label={label}
          aria-invalid={!!error}
          {...rest}
        />
      </div>
      {!!error && <div style={{ ...typography.caption, color: colors.danger, marginTop: 4 }}>{error}</div>}
    </div>
  );
}
