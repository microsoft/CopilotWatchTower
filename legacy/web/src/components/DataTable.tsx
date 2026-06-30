import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

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
  fill?: boolean;
  resizable?: boolean;
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
  fill = false,
  resizable = false,
  onRowClick,
  selectedRowKey,
}: DataTableProps<T>) {
  const { t } = useTranslation("components");
  const [sortKey, setSortKey] = useState<string | undefined>(initialSort?.key);
  const [direction, setDirection] = useState<"asc" | "desc">(initialSort?.direction ?? "desc");
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const resizeRef = useRef<{ key: string; startX: number; startW: number } | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);

  useEffect(() => {
    if (!resizable) return;
    function onMove(event: MouseEvent) {
      const state = resizeRef.current;
      if (!state) return;
      const next = Math.max(48, state.startW + (event.clientX - state.startX));
      setColWidths((prev) => ({ ...prev, [state.key]: next }));
    }
    function onUp() {
      if (resizeRef.current) {
        resizeRef.current = null;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [resizable]);

  function startResize(event: React.MouseEvent, column: Column<T>) {
    event.preventDefault();
    event.stopPropagation();
    const th = (event.currentTarget as HTMLElement).closest("th");
    const startW = colWidths[column.key] ?? th?.offsetWidth ?? 120;
    resizeRef.current = { key: column.key, startX: event.clientX, startW };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

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
    <div
      style={
        fill
          ? { flex: 1, minHeight: 0, overflow: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }
          : { maxHeight, overflow: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }
      }
    >
      <table
        ref={tableRef}
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontSize: 12.5,
          tableLayout: resizable ? "fixed" : "auto",
        }}
      >
        <thead>
          <tr>
            {columns.map((column) => {
              const isSorted = sortKey === column.key;
              const resolvedWidth = colWidths[column.key] ?? column.width;
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
                    width: resolvedWidth,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    fontVariantNumeric: "tabular-nums",
                  }}
                  title={column.sortValue ? t("dataTable.sortHint") : undefined}
                >
                  {column.header}
                  {isSorted && <span style={{ marginLeft: 4 }}>{direction === "asc" ? "▲" : "▼"}</span>}
                  {resizable && (
                    <span
                      onMouseDown={(e) => startResize(e, column)}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        position: "absolute",
                        top: 0,
                        right: 0,
                        height: "100%",
                        width: 8,
                        cursor: "col-resize",
                        userSelect: "none",
                      }}
                      title={t("dataTable.resizeHint")}
                    />
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="empty-state" style={{ textAlign: "center" }}>
                {empty ?? t("dataTable.empty")}
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
                      overflow: resizable ? "hidden" : undefined,
                      textOverflow: resizable ? "ellipsis" : undefined,
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
