import React from 'react';
import { Loader2 } from 'lucide-react';

const VARIANT_CLASS = {
  primary: 'ft-btn-primary',
  secondary: 'ft-btn-secondary',
  danger: 'ft-btn-danger',
  'danger-solid': 'ft-btn-danger-solid',
  success: 'ft-btn-success',
};

/**
 * The single button primitive every page should use — variant covers the
 * primary/secondary/danger/success look, loading/disabled states are baked
 * in so no page re-implements its own button styling.
 */
export default function Button({
  children,
  variant = 'primary',
  icon,
  loading = false,
  disabled = false,
  type = 'button',
  onClick,
  style,
  fullWidthMobile = false,
  ...rest
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      className={`ft-btn ${VARIANT_CLASS[variant] || VARIANT_CLASS.primary} ${fullWidthMobile ? 'ft-full-width-mobile' : ''}`}
      style={{ height: 42, padding: '0 18px', ...style }}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 size={16} className="ft-spin" /> : icon}
      {children}
    </button>
  );
}
