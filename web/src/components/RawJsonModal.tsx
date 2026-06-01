import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Braces, Check, Copy, X } from "lucide-react";

function prettify(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

interface RawJsonModalProps {
  title: string;
  raw: string | null | undefined;
  onClose: () => void;
}

export function RawJsonModal({ title, raw, onClose }: RawJsonModalProps) {
  const [copied, setCopied] = useState(false);
  const pretty = prettify(raw);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleCopy = () => {
    if (!pretty) return;
    void navigator.clipboard.writeText(pretty).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return createPortal(
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(860px, 100%)",
          maxHeight: "84vh",
          display: "flex",
          flexDirection: "column",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md, 10px)",
          boxShadow: "0 16px 48px rgba(0,0,0,0.35)",
          overflow: "hidden",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600 }}>
            <Braces size={15} color="var(--accent)" />
            {title}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              onClick={handleCopy}
              disabled={!pretty}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                padding: "5px 10px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--surface-muted)",
                color: "var(--text)",
                cursor: pretty ? "pointer" : "not-allowed",
              }}
            >
              {copied ? <Check size={14} color="var(--ok)" /> : <Copy size={14} />}
              {copied ? "복사됨" : "복사"}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="닫기"
              style={{
                display: "flex",
                alignItems: "center",
                padding: 6,
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--surface-muted)",
                color: "var(--text)",
                cursor: "pointer",
              }}
            >
              <X size={14} />
            </button>
          </span>
        </header>
        <pre
          style={{
            margin: 0,
            padding: 16,
            overflow: "auto",
            fontSize: 12,
            lineHeight: 1.55,
            fontFamily: "var(--font-mono, monospace)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "var(--text)",
          }}
        >
          {pretty || "(원본 데이터 없음)"}
        </pre>
      </div>
    </div>,
    document.body,
  );
}

interface RawJsonButtonProps {
  raw: string | null | undefined;
  title: string;
  label?: string;
}

/** Small inline button that opens the raw JSON in a modal. */
export function RawJsonButton({ raw, title, label }: RawJsonButtonProps) {
  const [open, setOpen] = useState(false);
  const disabled = !raw;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        title={disabled ? "원본 데이터 없음" : "원본 데이터 보기"}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontSize: 11,
          padding: label ? "2px 8px" : 3,
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "transparent",
          color: disabled ? "var(--text-muted)" : "var(--accent-strong)",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Braces size={13} />
        {label}
      </button>
      {open && <RawJsonModal title={title} raw={raw} onClose={() => setOpen(false)} />}
    </>
  );
}
