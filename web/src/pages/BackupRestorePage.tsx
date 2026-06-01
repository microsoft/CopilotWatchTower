import { useEffect, useState } from "react";
import { DatabaseBackup, FolderOpen, Upload } from "lucide-react";

import { Card } from "../components/Card";
import { useToast } from "../components/Toast";
import { primaryButtonStyle, secondaryButtonStyle } from "../components/settingsControls";
import {
  type BackupManifest,
  type BridgeEvent,
  createBackup,
  inspectBackup,
  isBridgeAvailable,
  openExportsFolder,
  pickBackupFile,
  restoreBackup,
  subscribeBridgeEvents,
} from "../lib/bridge";

const BRIDGE_AVAILABLE = isBridgeAvailable();

interface ProgressState {
  label: string;
  current: number;
  total: number;
}

interface RestoreResult {
  added?: number;
  skipped?: number;
  threads_recomputed?: number;
  source_profile?: { name?: string } | null;
}

export function BackupRestorePage() {
  const toast = useToast();
  const [backupBusy, setBackupBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [backupProgress, setBackupProgress] = useState<ProgressState | null>(null);
  const [restoreProgress, setRestoreProgress] = useState<ProgressState | null>(null);
  const [lastBackup, setLastBackup] = useState<{ filename: string; row_total: number } | null>(null);
  const [lastRestore, setLastRestore] = useState<RestoreResult | null>(null);
  const [pendingFile, setPendingFile] = useState<string | null>(null);
  const [pendingManifest, setPendingManifest] = useState<BackupManifest | null>(null);

  useEffect(() => {
    if (!BRIDGE_AVAILABLE) return;
    let dispose: (() => void) | undefined;
    subscribeBridgeEvents((event: BridgeEvent) => {
      handleEvent(event);
    }).then((off) => {
      dispose = off;
    });
    return () => dispose?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleEvent(event: BridgeEvent) {
    const p = event.payload as Record<string, unknown>;
    switch (event.type) {
      case "backup.progress":
        setBackupProgress({
          label: String(p.label ?? ""),
          current: Number(p.current ?? 0),
          total: Number(p.total ?? 0),
        });
        break;
      case "backup.finished":
        setBackupBusy(false);
        setBackupProgress(null);
        setLastBackup({
          filename: String(p.filename ?? ""),
          row_total: Number(p.row_total ?? 0),
        });
        toast.push(`백업 완료: ${p.filename}`, "success");
        break;
      case "backup.failed":
        setBackupBusy(false);
        setBackupProgress(null);
        toast.push(`백업 실패: ${p.error ?? "알 수 없는 오류"}`, "danger");
        break;
      case "restore.progress":
        setRestoreProgress({
          label: String(p.label ?? ""),
          current: Number(p.current ?? 0),
          total: Number(p.total ?? 0),
        });
        break;
      case "restore.finished":
        setRestoreBusy(false);
        setRestoreProgress(null);
        setLastRestore(p as RestoreResult);
        setPendingFile(null);
        setPendingManifest(null);
        toast.push(`복원 완료: ${p.added ?? 0}건 추가, ${p.skipped ?? 0}건 중복 스킵`, "success");
        break;
      case "restore.failed":
        setRestoreBusy(false);
        setRestoreProgress(null);
        toast.push(`복원 실패: ${p.error ?? "알 수 없는 오류"}`, "danger");
        break;
      default:
        break;
    }
  }

  async function onBackup() {
    setBackupBusy(true);
    setLastBackup(null);
    const result = await createBackup();
    if (!result.ok) {
      setBackupBusy(false);
      toast.push(`백업 시작 실패: ${result.error ?? "알 수 없는 오류"}`, "danger");
    }
  }

  async function onPickFile() {
    const picked = await pickBackupFile();
    if (!picked.ok || !picked.path) return;
    setPendingFile(picked.path);
    setPendingManifest(null);
    const info = await inspectBackup(picked.path);
    if (info.ok && info.manifest) {
      setPendingManifest(info.manifest);
    } else {
      toast.push(info.error ?? "백업 파일을 읽을 수 없습니다.", "danger");
    }
  }

  async function onRestore() {
    if (!pendingFile) return;
    setRestoreBusy(true);
    setLastRestore(null);
    const result = await restoreBackup(pendingFile);
    if (!result.ok) {
      setRestoreBusy(false);
      toast.push(`복원 시작 실패: ${result.error ?? "알 수 없는 오류"}`, "danger");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <section style={{ display: "flex", flexDirection: "column", gap: 16, padding: "18px 24px" }}>
        {!BRIDGE_AVAILABLE && (
          <Card>
            <p style={{ margin: 0, color: "var(--text-muted)" }}>
              데스크톱 앱에서만 백업·복원을 사용할 수 있습니다.
            </p>
          </Card>
        )}

        <Card
          title="데이터 백업"
          actions={
            <button type="button" style={secondaryButtonStyle} onClick={() => openExportsFolder()}>
              <FolderOpen size={14} style={{ marginRight: 6, verticalAlign: "-2px" }} />
              내보내기 폴더 열기
            </button>
          }
        >
          <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>
            현재 프로필의 수집 데이터를 휴대용 백업 파일(.cwtbackup)로 만듭니다. 설정과 비밀 값은 포함되지 않습니다.
          </p>
          <div>
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={!BRIDGE_AVAILABLE || backupBusy}
              onClick={onBackup}
            >
              <DatabaseBackup size={14} style={{ marginRight: 6, verticalAlign: "-2px" }} />
              {backupBusy ? "백업 중…" : "백업 만들기"}
            </button>
          </div>
          {backupProgress && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
              {backupProgress.label}
              {backupProgress.total > 0 ? ` (${backupProgress.current}/${backupProgress.total})` : ""}
            </p>
          )}
          {lastBackup && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--text)" }}>
              ✓ {lastBackup.filename} · 총 {lastBackup.row_total.toLocaleString()}행
            </p>
          )}
        </Card>

        <Card title="데이터 복원(불러오기)">
          <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>
            백업 파일을 현재 활성 프로필로 가져옵니다. 이미 존재하는 항목은 자동으로 중복 제외(스킵)됩니다.
            새 프로필로 불러오려면 먼저 설정에서 프로필을 만들고 전환한 뒤 복원하세요.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" style={secondaryButtonStyle} disabled={!BRIDGE_AVAILABLE} onClick={onPickFile}>
              <Upload size={14} style={{ marginRight: 6, verticalAlign: "-2px" }} />
              백업 파일 선택
            </button>
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={!BRIDGE_AVAILABLE || !pendingFile || restoreBusy}
              onClick={onRestore}
            >
              {restoreBusy ? "복원 중…" : "선택한 백업 복원"}
            </button>
          </div>
          {pendingFile && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", wordBreak: "break-all" }}>
              선택됨: {pendingFile}
            </p>
          )}
          {pendingManifest && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--text)" }}>
              백업 정보: {pendingManifest.profile?.name ?? "이름 없음"} · 총{" "}
              {(pendingManifest.row_total ?? 0).toLocaleString()}행 · 생성{" "}
              {pendingManifest.created_at ?? "?"}
            </p>
          )}
          {restoreProgress && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
              {restoreProgress.label}
              {restoreProgress.total > 0 ? ` (${restoreProgress.current}/${restoreProgress.total})` : ""}
            </p>
          )}
          {lastRestore && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--text)" }}>
              ✓ {lastRestore.added ?? 0}건 추가 · {lastRestore.skipped ?? 0}건 중복 스킵 ·{" "}
              스레드 {lastRestore.threads_recomputed ?? 0}개 재계산
            </p>
          )}
        </Card>
      </section>
    </div>
  );
}
