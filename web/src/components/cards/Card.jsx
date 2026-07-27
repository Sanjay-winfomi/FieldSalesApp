import React from 'react';
import { spacing } from '../../theme';

/**
 * Base card shell reused by every specialized card — 16px radius, soft
 * shadow, subtle border, consistent padding, optional hover elevation.
 */
export default function Card({ children, hoverable = false, selected = false, onClick, style, noPadding = false, className = '', ...rest }) {
  const classes = [
    'ft-card',
    hoverable ? 'ft-card-hoverable' : '',
    onClick ? 'ft-card-selectable' : '',
    selected ? 'ft-card-selected' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div
      className={classes}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } } : undefined}
      style={{ padding: noPadding ? 0 : spacing.xl, ...style }}
      {...rest}
    >
      {children}
    </div>
  );
}
