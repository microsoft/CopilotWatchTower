import { useEffect, useState } from "react";
import { Download, FileText, FolderOpen, MessageSquareText } from "lucide-react";

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
        toast.push(`내보내기 완료: ${p.filename} (${p.count ?? 0}건)`, "success");
        break;
      case "export.failed":
        setBusy(false);
        setProgress(null);
        toast.push(`내보내기 실패: ${p.error ?? "알 수 없는 오류"}`, "danger");
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
      toast.push(`내보내기 시작 실패: ${result.error ?? "알 수 없는 오류"}`, "danger");
    }
  }

  async function onExportThreads() {
    setBusy(true);
    setLastFile(null);
    const result = await exportAllThreads(threadFmt);
    if (!result.ok) {
      setBusy(false);
      toast.push(`내보내기 시작 실패: ${result.error ?? "알 수 없는 오류"}`, "danger");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <section style={{ display: "flex", flexDirection: "column", gap: 16, padding: "18px 24px" }}>
        {!BRIDGE_AVAILABLE && (
          <Card>
            <p style={{ margin: 0, color: "var(--text-muted)" }}>
              데스크톱 앱에서만 내보내기를 사용할 수 있습니다.
            </p>
          </Card>
        )}

        <Card
          title="상호작용 내보내기"
          actions={
            <button type="button" style={secondaryButtonStyle} onClick={() => openExportsFolder()}>
              <FolderOpen size={14} style={{ marginRight: 6, verticalAlign: "-2px" }} />
              내보내기 폴더 열기
            </button>
          }
        >
          <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>
            현재 프로필의 모든 상호작용을 한 파일로 내보냅니다.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <select
              title="상호작용 내보내기 형식"
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
              상호작용 내보내기
            </button>
          </div>
        </Card>

        <Card title="스레드 내보내기">
          <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>
            현재 프로필의 모든 대화 스레드를 한 파일로 내보냅니다. 개별 스레드는 대화 탐색 화면에서 내보낼 수 있습니다.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <select
              title="스레드 내보내기 형식"
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
              스레드 내보내기
            </button>
          </div>
        </Card>

        {(progress || lastFile) && (
          <Card title="상태">
            {progress && (
              <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{progress}</p>
            )}
            {lastFile && (
              <p style={{ margin: 0, fontSize: 12, color: "var(--text)" }}>
                <FileText size={13} style={{ marginRight: 6, verticalAlign: "-2px" }} />
                {lastFile.filename} · {lastFile.count.toLocaleString()}건
              </p>
            )}
          </Card>
        )}
      </section>
    </div>
  );
}
