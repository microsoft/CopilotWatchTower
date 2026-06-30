import { useEffect, useState } from "react";
import { Download, FileText, FolderOpen, MessageSquareText } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Card } from "../components/Card";
import { useToast } from "../components/Toast";
import { primaryButtonStyle, secondaryButtonStyle } from "../components/settingsControls";
import {
  type BridgeEvent,
  type InteractionExportFormat,
  type ThreadExportFormat,
  exportAllThreads,
  exportInteractions,
  isBridgeAvailable,
  openExportsFolder,
  subscribeBridgeEvents,
} from "../lib/bridge";

const BRIDGE_AVAILABLE = isBridgeAvailable();

const INTERACTION_FORMATS: InteractionExportFormat[] = ["csv", "json", "xlsx"];
const THREAD_FORMATS: ThreadExportFormat[] = ["md", "html", "json"];

const selectStyle: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
};

export function DataExportPage() {
  const { t } = useTranslation(["dataExport", "common"]);
  const toast = useToast();
  const [interactionFmt, setInteractionFmt] = useState<InteractionExportFormat>("csv");
  const [threadFmt, setThreadFmt] = useState<ThreadExportFormat>("md");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [lastFile, setLastFile] = useState<{ filename: string; count: number } | null>(null);

  useEffect(() => {
    if (!BRIDGE_AVAILABLE) return;
    let dispose: (() => void) | undefined;
    subscribeBridgeEvents((event: BridgeEvent) => handleEvent(event)).then((off) => {
      dispose = off;
    });
    return () => dispose?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleEvent(event: BridgeEvent) {
    const p = event.payload as Record<string, unknown>;
    switch (event.type) {
      case "export.progress":
        setProgress(String(p.label ?? ""));
        break;
      case "export.finished":
        setBusy(false);
        setProgress(null);
        setLastFile({ filename: String(p.filename ?? ""), count: Number(p.count ?? 0) });
        toast.push(
          t("dataExport:toasts.exportComplete", { filename: p.filename, n: p.count ?? 0 }),
          "success",
        );
        void openExportsFolder();
        break;
      case "export.failed":
        setBusy(false);
        setProgress(null);
        toast.push(
          t("dataExport:toasts.exportFailed", { error: p.error ?? t("common:unknownError") }),
          "danger",
        );
        break;
      default:
        break;
    }
  }

  async function onExportInteractions() {
    setBusy(true);
    setLastFile(null);
    const result = await exportInteractions(interactionFmt);
    if (!result.ok) {
      setBusy(false);
      toast.push(
        t("dataExport:toasts.startFailed", { error: result.error ?? t("common:unknownError") }),
        "danger",
      );
    }
  }

  async function onExportThreads() {
    setBusy(true);
    setLastFile(null);
    const result = await exportAllThreads(threadFmt);
    if (!result.ok) {
      setBusy(false);
      toast.push(
        t("dataExport:toasts.startFailed", { error: result.error ?? t("common:unknownError") }),
        "danger",
      );
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <section style={{ display: "flex", flexDirection: "column", gap: 16, padding: "18px 24px" }}>
        {!BRIDGE_AVAILABLE && (
          <Card>
            <p style={{ margin: 0, color: "var(--text-muted)" }}>
              {t("dataExport:bridgeUnavailable")}
            </p>
          </Card>
        )}

        <Card
          title={t("dataExport:interactions.title")}
          actions={
            <button type="button" style={secondaryButtonStyle} onClick={() => openExportsFolder()}>
              <FolderOpen size={14} style={{ marginRight: 6, verticalAlign: "-2px" }} />
              {t("dataExport:openFolder")}
            </button>
          }
        >
          <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>
            {t("dataExport:interactions.description")}
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <select
              title={t("dataExport:interactions.formatLabel")}
              style={selectStyle}
              value={interactionFmt}
              onChange={(e) => setInteractionFmt(e.target.value as InteractionExportFormat)}
            >
              {INTERACTION_FORMATS.map((fmt) => (
                <option key={fmt} value={fmt}>
                  {fmt.toUpperCase()}
                </option>
              ))}
            </select>
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={!BRIDGE_AVAILABLE || busy}
              onClick={onExportInteractions}
            >
              <Download size={14} style={{ marginRight: 6, verticalAlign: "-2px" }} />
              {t("dataExport:interactions.exportButton")}
            </button>
          </div>
        </Card>

        <Card title={t("dataExport:threads.title")}>
          <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>
            {t("dataExport:threads.description")}
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <select
              title={t("dataExport:threads.formatLabel")}
              style={selectStyle}
              value={threadFmt}
              onChange={(e) => setThreadFmt(e.target.value as ThreadExportFormat)}
            >
              {THREAD_FORMATS.map((fmt) => (
                <option key={fmt} value={fmt}>
                  {fmt.toUpperCase()}
                </option>
              ))}
            </select>
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={!BRIDGE_AVAILABLE || busy}
              onClick={onExportThreads}
            >
              <MessageSquareText size={14} style={{ marginRight: 6, verticalAlign: "-2px" }} />
              {t("dataExport:threads.exportButton")}
            </button>
          </div>
        </Card>

        {(progress || lastFile) && (
          <Card title={t("dataExport:status.title")}>
            {progress && (
              <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{progress}</p>
            )}
            {lastFile && (
              <p style={{ margin: 0, fontSize: 12, color: "var(--text)" }}>
                <FileText size={13} style={{ marginRight: 6, verticalAlign: "-2px" }} />
                {t("dataExport:status.fileLine", {
                  filename: lastFile.filename,
                  n: lastFile.count.toLocaleString(),
                })}
              </p>
            )}
          </Card>
        )}
      </section>
    </div>
  );
}
