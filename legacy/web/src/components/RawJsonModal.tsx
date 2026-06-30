import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation(["components", "common"]);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const pretty = prettify(raw);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleCopy = async () => {
    if (!pretty) return;
    setCopyError(null);

    const copyWithExecCommand = (text: string): boolean => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "true");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.left = "-1000px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } finally {
        document.body.removeChild(ta);
      }
      return ok;
    };

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(pretty);
      } else if (!copyWithExecCommand(pretty)) {
        throw new Error("fallback copy failed");
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
      return;
    } catch {
      if (copyWithExecCommand(pretty)) {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
        return;
      }
    }

    setCopyError(t("rawJsonModal.copyFailed"));
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
              {copied ? t("rawJsonModal.copied") : t("rawJsonModal.copy")}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common:close")}
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
          {pretty || t("rawJsonModal.emptyBody")}
        </pre>
        {copyError ? (
          <div
            role="status"
            style={{
              padding: "8px 16px 12px",
              fontSize: 12,
              color: "var(--danger, #d14343)",
              borderTop: "1px solid var(--border)",
              background: "var(--surface-muted)",
            }}
          >
            {copyError}
          </div>
        ) : null}
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
  const { t } = useTranslation("components");
  const [open, setOpen] = useState(false);
  const disabled = !raw;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        title={disabled ? t("rawJsonModal.noRawData") : t("rawJsonModal.viewRawData")}
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
