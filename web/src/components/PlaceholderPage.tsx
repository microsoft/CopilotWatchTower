interface PlaceholderPageProps {
  title: string;
  description: string;
  milestone: string;
}

export function PlaceholderPage({ title, description, milestone }: PlaceholderPageProps) {
  return (
    <section style={{ padding: "24px", display: "flex", flexDirection: "column", gap: 12, flex: 1 }}>
      <div
        style={{
          background: "var(--surface)",
          border: "1px dashed var(--border-strong)",
          borderRadius: "var(--radius-md)",
          padding: "32px 28px",
          textAlign: "center",
          color: "var(--text-soft)",
        }}
      >
        <div style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 700, letterSpacing: "0.05em" }}>
          {milestone}
        </div>
        <h3 style={{ margin: "8px 0 4px", color: "var(--text)" }}>{title}</h3>
        <p style={{ margin: 0, fontSize: 13 }}>{description}</p>
      </div>
    </section>
  );
}
