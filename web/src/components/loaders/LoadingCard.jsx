import React from 'react';
import { Loader2 } from 'lucide-react';
import { colors, typography } from '../../theme';

export default function LoadingCard({ message = 'Loading...' }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 48 }}>
      <Loader2 size={18} className="ft-spin" color={colors.primary} />
      <span style={{ ...typography.body, color: colors.textSecondary }}>{message}</span>
    </div>
  );
}
