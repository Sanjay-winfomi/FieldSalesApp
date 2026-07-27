import React from 'react';

export function SkeletonBlock({ width = '100%', height = 16, style }) {
  return <div className="ft-skeleton" style={{ width, height, ...style }} />;
}

/** Skeleton row set matching a DataTable's shape, shown while data loads. */
export function SkeletonTable({ columns = 5, rows = 6 }) {
  return (
    <table className="ft-table" style={{ width: '100%' }}>
      <tbody>
        {Array.from({ length: rows }).map((_, r) => (
          <tr key={r}>
            {Array.from({ length: columns }).map((__, c) => (
              <td key={c} style={{ padding: '12px 16px' }}>
                <SkeletonBlock height={14} width={c === 0 ? '70%' : '85%'} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Skeleton card matching an EmployeeCard/MetricCard footprint. */
export function SkeletonCard() {
  return (
    <div className="ft-card" style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <SkeletonBlock width={40} height={40} style={{ borderRadius: 20 }} />
        <div style={{ flex: 1 }}>
          <SkeletonBlock width="60%" height={14} />
          <SkeletonBlock width="40%" height={11} style={{ marginTop: 8 }} />
        </div>
      </div>
      <SkeletonBlock width="90%" height={12} />
    </div>
  );
}
