import type { ReactNode } from "react";

interface KpiCardProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "neutral" | "positive" | "warn" | "danger";
  icon?: ReactNode;
}

const TONE_COLOR: Record<NonNullable<KpiCardProps["tone"]>, string> = {
  neutral: "var(--text-soft)",
  positive: "var(--ok)",
  warn: "var(--warn)",
  danger: "var(--danger)",
};

export function KpiCard({ label, value, hint, tone = "neutral", icon }: KpiCardProps) {
  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-card)",
        padding: "18px 18px",
        display: "grid",
        gridTemplateColumns: icon ? "42px 1fr" : "1fr",
        gap: 12,
        alignItems: "center",
      }}
    >
      {icon && (
        <div
          style={{
            width: 42,
            height: 42,
            borderRadius: 999,
            display: "grid",
            placeItems: "center",
            background: tone === "danger" ? "var(--danger-soft)" : tone === "warn" ? "var(--warn-soft)" : tone === "positive" ? "var(--teal-soft)" : "var(--accent-soft)",
            color: tone === "danger" ? "var(--danger)" : tone === "warn" ? "var(--warn)" : tone === "positive" ? "var(--teal)" : "var(--accent)",
          }}
        >
          {icon}
        </div>
      )}
      <div>
        <div style={{ fontSize: 12, color: "var(--text-soft)", fontWeight: 700 }}>{label}</div>
        <div style={{ fontSize: 24, fontWeight: 800, color: "var(--text)", lineHeight: 1.25 }}>{value}</div>
        {hint && <div style={{ fontSize: 11, color: TONE_COLOR[tone], marginTop: 2 }}>{hint}</div>}
      </div>
    </div>
  );
}
