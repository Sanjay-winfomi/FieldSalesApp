import React, { useMemo, useState } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { SkeletonTable } from '../loaders/Skeleton';
import EmptyState from '../EmptyState';
import Pagination from './Pagination';
import { colors } from '../../theme';

/**
 * Generic enterprise data table — sticky header, zebra rows, row hover,
 * client-side sort + pagination, loading skeleton and empty state built in.
 * `columns`: [{ key, label, render?(row), sortable? = true, width? }]
 */
export default function DataTable({
  columns,
  rows,
  loading = false,
  emptyTitle = 'No records found',
  emptySubtitle,
  getRowKey = (row, i) => row.id ?? i,
  pageSize = 25,
  onRowClick,
  rowTitle,
}) {
  const [sort, setSort] = useState({ key: null, dir: 'asc' });
  const [page, setPage] = useState(1);

  const sortedRows = useMemo(() => {
    if (!sort.key) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return av - bv;
      return String(av).localeCompare(String(bv));
    });
    if (sort.dir === 'desc') copy.reverse();
    return copy;
  }, [rows, sort]);

  const pageCount = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const clampedPage = Math.min(page, pageCount);
  const pageRows = sortedRows.slice((clampedPage - 1) * pageSize, clampedPage * pageSize);

  const toggleSort = (key) => {
    setSort((prev) => {
      if (prev.key !== key) return { key, dir: 'asc' };
      if (prev.dir === 'asc') return { key, dir: 'desc' };
      return { key: null, dir: 'asc' };
    });
  };

  if (loading) {
    return <SkeletonTable columns={columns.length} />;
  }

  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} subtitle={emptySubtitle} />;
  }

  return (
    <div>
      <div className="ft-table-scroll" style={{ overflowX: 'auto', maxHeight: 560, overflowY: 'auto' }}>
        <table className="ft-table">
          <thead>
            <tr>
              {columns.map((col) => {
                const sortable = col.sortable !== false;
                const active = sort.key === col.key;
                return (
                  <th
                    key={col.key}
                    style={{ width: col.width, cursor: sortable ? 'pointer' : 'default', userSelect: 'none' }}
                    onClick={sortable ? () => toggleSort(col.key) : undefined}
                    aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {col.label}
                      {sortable && (
                        active ? (
                          sort.dir === 'asc' ? <ChevronUp size={13} /> : <ChevronDown size={13} />
                        ) : (
                          <ChevronsUpDown size={13} color={colors.textMuted} />
                        )
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, i) => (
              <tr
                key={getRowKey(row, i)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                style={onRowClick ? { cursor: 'pointer' } : undefined}
              >
                {columns.map((col) => (
                  <td key={col.key} title={rowTitle ? rowTitle(row, col) : undefined}>
                    {col.render ? col.render(row) : (row[col.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination
        page={clampedPage}
        pageCount={pageCount}
        totalItems={sortedRows.length}
        pageSize={pageSize}
        onPageChange={setPage}
      />
    </div>
  );
}
