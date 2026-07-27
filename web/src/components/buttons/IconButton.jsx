import React from 'react';

export default function IconButton({ icon, onClick, title, size = 36, style, ...rest }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="ft-icon-btn"
      style={{ width: size, height: size, ...style }}
      {...rest}
    >
      {icon}
    </button>
  );
}
