import { useMemo, useState, type ReactNode } from "react";

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: "left" | "right";
  width?: number | string;
  sortValue?: (row: T) => string | number | null;
  title?: (row: T) => string | undefined;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  empty?: ReactNode;
  rowKey: (row: T) => string;
  initialSort?: { key: string; direction: "asc" | "desc" };
  maxHeight?: number | string;
  onRowClick?: (row: T) => void;
  selectedRowKey?: string | null;
}

export function DataTable<T>({
  columns,
  rows,
  empty,
  rowKey,
  initialSort,
  maxHeight = 360,
  onRowClick,
  selectedRowKey,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | undefined>(initialSort?.key);
  const [direction, setDirection] = useState<"asc" | "desc">(initialSort?.direction ?? "desc");

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const column = columns.find((c) => c.key === sortKey);
    if (!column?.sortValue) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const va = column.sortValue!(a);
      const vb = column.sortValue!(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (va < vb) return direction === "asc" ? -1 : 1;
      if (va > vb) return direction === "asc" ? 1 : -1;
      return 0;
    });
    return copy;
  }, [rows, columns, sortKey, direction]);

  const handleSort = (column: Column<T>) => {
    if (!column.sortValue) return;
    if (sortKey === column.key) {
      setDirection(direction === "asc" ? "desc" : "asc");
    } else {
      setSortKey(column.key);
      setDirection("desc");
    }
  };

  return (
    <div style={{ maxHeight, overflow: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead>
          <tr>
            {columns.map((column) => {
              const isSorted = sortKey === column.key;
              return (
                <th
                  key={column.key}
                  onClick={() => handleSort(column)}
                  style={{
                    textAlign: column.align ?? "left",
                    padding: "8px 10px",
                    background: "var(--surface-muted)",
                    color: "var(--text-muted)",
                    fontWeight: 600,
                    borderBottom: "1px solid var(--border)",
                    position: "sticky",
                    top: 0,
                    cursor: column.sortValue ? "pointer" : "default",
                    width: column.width,
                    whiteSpace: "nowrap",
                    fontVariantNumeric: "tabular-nums",
                  }}
                  title={column.sortValue ? "클릭하여 정렬" : undefined}
                >
                  {column.header}
                  {isSorted && <span style={{ marginLeft: 4 }}>{direction === "asc" ? "▲" : "▼"}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="empty-state" style={{ textAlign: "center" }}>
                {empty ?? "표시할 데이터가 없습니다."}
              </td>
            </tr>
          ) : (
            sorted.map((row) => {
              const key = rowKey(row);
              const selected = selectedRowKey === key;
              return (
              <tr
                key={key}
                onClick={() => onRowClick?.(row)}
                style={{
                  cursor: onRowClick ? "pointer" : undefined,
                  background: selected ? "var(--accent-soft)" : undefined,
                }}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    title={column.title?.(row)}
                    style={{
                      textAlign: column.align ?? "left",
                      padding: "8px 10px",
                      borderBottom: "1px solid var(--border)",
                      whiteSpace: "nowrap",
                      fontVariantNumeric: column.align === "right" ? "tabular-nums" : undefined,
                    }}
                  >
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
