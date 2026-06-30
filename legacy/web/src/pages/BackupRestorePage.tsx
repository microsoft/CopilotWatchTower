import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DatabaseBackup, FolderOpen, Trash2, Upload } from "lucide-react";

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
  wipeProfileData,
} from "../lib/bridge";

const BRIDGE_AVAILABLE = isBridgeAvailable();

const dangerButtonStyle = {
  ...primaryButtonStyle,
  background: "var(--danger)",
};

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
  const { t } = useTranslation(["backup", "common"]);
  const toast = useToast();
  const [backupBusy, setBackupBusy] = useState(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [backupProgress, setBackupProgress] = useState<ProgressState | null>(null);
  const [restoreProgress, setRestoreProgress] = useState<ProgressState | null>(null);
  const [lastBackup, setLastBackup] = useState<{ filename: string; row_total: number } | null>(null);
  const [lastRestore, setLastRestore] = useState<RestoreResult | null>(null);
  const [pendingFile, setPendingFile] = useState<string | null>(null);
  const [pendingManifest, setPendingManifest] = useState<BackupManifest | null>(null);
  const [wipeBusy, setWipeBusy] = useState(false);
  const [wipeConfirm, setWipeConfirm] = useState(false);
  const [wipeProgress, setWipeProgress] = useState<ProgressState | null>(null);
  const [lastWipe, setLastWipe] = useState<number | null>(null);

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
        toast.push(t("backup:toasts.backupFinished", { filename: p.filename }), "success");
        break;
      case "backup.failed":
        setBackupBusy(false);
        setBackupProgress(null);
        toast.push(t("backup:toasts.backupFailed", { error: p.error ?? t("common:unknownError") }), "danger");
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
        toast.push(t("backup:toasts.restoreFinished", { added: p.added ?? 0, skipped: p.skipped ?? 0 }), "success");
        break;
      case "restore.failed":
        setRestoreBusy(false);
        setRestoreProgress(null);
        toast.push(t("backup:toasts.restoreFailed", { error: p.error ?? t("common:unknownError") }), "danger");
        break;
      case "wipe.progress":
        setWipeProgress({
          label: String(p.label ?? ""),
          current: Number(p.current ?? 0),
          total: Number(p.total ?? 0),
        });
        break;
      case "wipe.finished":
        setWipeBusy(false);
        setWipeConfirm(false);
        setWipeProgress(null);
        setLastWipe(Number(p.deleted ?? 0));
        toast.push(t("backup:toasts.wipeFinished", { deleted: p.deleted ?? 0 }), "success");
        break;
      case "wipe.failed":
        setWipeBusy(false);
        setWipeProgress(null);
        toast.push(t("backup:toasts.wipeFailed", { error: p.error ?? t("common:unknownError") }), "danger");
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
      toast.push(t("backup:toasts.backupStartFailed", { error: result.error ?? t("common:unknownError") }), "danger");
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
      toast.push(info.error ?? t("backup:toasts.inspectFailed"), "danger");
    }
  }

  async function onRestore() {
    if (!pendingFile) return;
    setRestoreBusy(true);
    setLastRestore(null);
    const result = await restoreBackup(pendingFile);
    if (!result.ok) {
      setRestoreBusy(false);
      toast.push(t("backup:toasts.restoreStartFailed", { error: result.error ?? t("common:unknownError") }), "danger");
    }
  }

  async function onWipe() {
    if (!wipeConfirm) {
      setWipeConfirm(true);
      return;
    }
    setWipeBusy(true);
    setLastWipe(null);
    const result = await wipeProfileData();
    if (!result.ok) {
      setWipeBusy(false);
      setWipeConfirm(false);
      toast.push(t("backup:toasts.wipeStartFailed", { error: result.error ?? t("common:unknownError") }), "danger");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <section style={{ display: "flex", flexDirection: "column", gap: 16, padding: "18px 24px" }}>
        {!BRIDGE_AVAILABLE && (
          <Card>
            <p style={{ margin: 0, color: "var(--text-muted)" }}>
              {t("backup:desktopOnly")}
            </p>
          </Card>
        )}

        <Card
          title={t("backup:backup.title")}
          actions={
            <button type="button" style={secondaryButtonStyle} onClick={() => openExportsFolder()}>
              <FolderOpen size={14} style={{ marginRight: 6, verticalAlign: "-2px" }} />
              {t("backup:backup.openFolder")}
            </button>
          }
        >
          <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>
            {t("backup:backup.description")}
          </p>
          <div>
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={!BRIDGE_AVAILABLE || backupBusy}
              onClick={onBackup}
            >
              <DatabaseBackup size={14} style={{ marginRight: 6, verticalAlign: "-2px" }} />
              {backupBusy ? t("backup:backup.busy") : t("backup:backup.create")}
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
              {t("backup:backup.lastResult", { filename: lastBackup.filename, rows: lastBackup.row_total.toLocaleString() })}
            </p>
          )}
        </Card>

        <Card title={t("backup:restore.title")}>
          <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>
            {t("backup:restore.description")}
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" style={secondaryButtonStyle} disabled={!BRIDGE_AVAILABLE} onClick={onPickFile}>
              <Upload size={14} style={{ marginRight: 6, verticalAlign: "-2px" }} />
              {t("backup:restore.pickFile")}
            </button>
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={!BRIDGE_AVAILABLE || !pendingFile || restoreBusy}
              onClick={onRestore}
            >
              {restoreBusy ? t("backup:restore.busy") : t("backup:restore.confirm")}
            </button>
          </div>
          {pendingFile && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", wordBreak: "break-all" }}>
              {t("backup:restore.selectedFile", { file: pendingFile })}
            </p>
          )}
          {pendingManifest && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--text)" }}>
              {t("backup:restore.manifestInfo", {
                name: pendingManifest.profile?.name ?? t("backup:restore.noName"),
                rows: (pendingManifest.row_total ?? 0).toLocaleString(),
                created: pendingManifest.created_at ?? "?",
              })}
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
              {t("backup:restore.lastResult", {
                added: lastRestore.added ?? 0,
                skipped: lastRestore.skipped ?? 0,
                threads: lastRestore.threads_recomputed ?? 0,
              })}
            </p>
          )}
        </Card>

        <Card title={t("backup:wipe.title")}>
          <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12 }}>
            {t("backup:wipe.description")}
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button
              type="button"
              style={dangerButtonStyle}
              disabled={!BRIDGE_AVAILABLE || wipeBusy}
              onClick={onWipe}
            >
              <Trash2 size={14} style={{ marginRight: 6, verticalAlign: "-2px" }} />
              {wipeBusy
                ? t("backup:wipe.busy")
                : wipeConfirm
                  ? t("backup:wipe.confirm")
                  : t("backup:wipe.button")}
            </button>
            {wipeConfirm && !wipeBusy && (
              <button type="button" style={secondaryButtonStyle} onClick={() => setWipeConfirm(false)}>
                {t("backup:wipe.cancel")}
              </button>
            )}
          </div>
          {wipeConfirm && !wipeBusy && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--danger)" }}>
              {t("backup:wipe.confirmPrompt")}
            </p>
          )}
          {wipeProgress && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
              {wipeProgress.label}
              {wipeProgress.total > 0 ? ` (${wipeProgress.current}/${wipeProgress.total})` : ""}
            </p>
          )}
          {lastWipe != null && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--text)" }}>
              {t("backup:wipe.lastResult", { deleted: lastWipe.toLocaleString() })}
            </p>
          )}
        </Card>
      </section>
    </div>
  );
}
