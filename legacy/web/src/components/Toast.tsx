import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ToastTone = "info" | "success" | "warn" | "danger";

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
  ttlMs: number;
}

interface ToastContextValue {
  toasts: Toast[];
  push: (message: string, tone?: ToastTone, ttlMs?: number) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (message: string, tone: ToastTone = "info", ttlMs = 4500) => {
      const id = nextId++;
      setToasts((prev) => [...prev, { id, message, tone, ttlMs }]);
    },
    [],
  );

  useEffect(() => {
    if (!toasts.length) return;
    const timers = toasts.map((t) => window.setTimeout(() => dismiss(t.id), t.ttlMs));
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [toasts, dismiss]);

  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return ctx;
}

const toneStyles: Record<ToastTone, { bg: string; border: string; color: string }> = {
  info: { bg: "var(--surface)", border: "var(--border-strong)", color: "var(--text)" },
  success: { bg: "var(--ok-soft)", border: "var(--ok)", color: "var(--ok)" },
  warn: { bg: "var(--warn-soft)", border: "var(--warn)", color: "var(--warn)" },
  danger: { bg: "var(--danger-soft)", border: "var(--danger)", color: "var(--danger)" },
};

function ToastViewport({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        zIndex: 9999,
        maxWidth: 360,
      }}
    >
      {toasts.map((toast) => {
        const tone = toneStyles[toast.tone];
        return (
          <div
            key={toast.id}
            style={{
              background: tone.bg,
              border: `1px solid ${tone.border}`,
              color: tone.color,
              borderRadius: 8,
              padding: "10px 12px",
              boxShadow: "var(--shadow-md)",
              fontSize: 12.5,
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
            }}
          >
            <div style={{ flex: 1, whiteSpace: "pre-wrap" }}>{toast.message}</div>
            <button
              onClick={() => onDismiss(toast.id)}
              style={{
                background: "transparent",
                border: 0,
                color: tone.color,
                fontSize: 14,
                cursor: "pointer",
                padding: 0,
                lineHeight: 1,
              }}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
