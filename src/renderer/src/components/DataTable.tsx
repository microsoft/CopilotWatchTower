import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNumberFormat } from '../lib/format'

export interface Column<T> {
  key: string
  header: string
  align?: 'left' | 'right'
  width?: number
  cell: (row: T) => ReactNode
  sortValue?: (row: T) => string | number
  title?: (row: T) => string | undefined
}

interface SortState {
  key: string
  direction: 'asc' | 'desc'
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  initialSort,
  maxHeight,
  onRowClick,
  selectedRowKey,
  pageSize
}: {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  initialSort?: SortState
  maxHeight?: number
  onRowClick?: (row: T) => void
  selectedRowKey?: string | null
  pageSize?: number
}): JSX.Element {
  const { t } = useTranslation()
  const n = useNumberFormat()
  const [sort, setSort] = useState<SortState | undefined>(initialSort)
  const [page, setPage] = useState(0)

  const sorted = useMemo(() => {
    if (!sort) return rows
    const col = columns.find((c) => c.key === sort.key)
    if (!col?.sortValue) return rows
    const dir = sort.direction === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const va = col.sortValue!(a)
      const vb = col.sortValue!(b)
      if (va < vb) return -1 * dir
      if (va > vb) return 1 * dir
      return 0
    })
  }, [rows, sort, columns])

  const toggle = (key: string): void => {
    const col = columns.find((c) => c.key === key)
    if (!col?.sortValue) return
    setSort((prev) =>
      prev?.key === key
        ? { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'desc' }
    )
  }

  const pageCount = pageSize ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1
  const curPage = Math.min(page, pageCount - 1)
  const visible = pageSize ? sorted.slice(curPage * pageSize, (curPage + 1) * pageSize) : sorted

  return (
    <div className="dt-wrap" style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}>
      <table className="table dt">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={`${c.align === 'right' ? 'right' : ''}${c.sortValue ? ' sortable' : ''}${
                  sort?.key === c.key ? ' sorted' : ''
                }`}
                style={c.width ? { width: c.width } : undefined}
                onClick={() => toggle(c.key)}
              >
                {c.header}
                {sort?.key === c.key ? (sort.direction === 'asc' ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => {
            const key = rowKey(row)
            return (
              <tr
                key={key}
                className={`${onRowClick ? 'clickable' : ''}${selectedRowKey === key ? ' selected' : ''}`}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key} className={c.align === 'right' ? 'right' : ''} title={c.title?.(row)}>
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            )
          })}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="dt-empty">
                {t('noData')}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {pageSize != null && sorted.length > pageSize && (
        <div className="dt-pager">
          <button className="btn-sm" disabled={curPage === 0} onClick={() => setPage(curPage - 1)}>
            {t('previous')}
          </button>
          <span className="dt-pager-info">
            {curPage * pageSize + 1}–{Math.min(sorted.length, (curPage + 1) * pageSize)} /{' '}
            {n(sorted.length)}
          </span>
          <button className="btn-sm" disabled={curPage >= pageCount - 1} onClick={() => setPage(curPage + 1)}>
            {t('next')}
          </button>
        </div>
      )}
    </div>
  )
}
