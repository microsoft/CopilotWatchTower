import type { CSSProperties, ReactNode } from "react";

interface CardProps {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
}

export function Card({ title, actions, children, style, bodyStyle }: CardProps) {
  return (
    <section
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-sm)",
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minHeight: 0,
        ...style,
      }}
    >
      {(title || actions) && (
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          {title && <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700 }}>{title}</h3>}
          {actions && <div>{actions}</div>}
        </header>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 0, ...bodyStyle }}>{children}</div>
    </section>
  );
}
