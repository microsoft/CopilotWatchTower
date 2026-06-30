import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Card } from "../components/Card";
import { DataTable } from "../components/DataTable";
import { LicenseConfigCard } from "../components/LicenseConfigCard";
import {
  ProfileAddButton,
  SettingsForm,
  profileColumnsFor,
  secondaryButtonStyle,
} from "../components/settingsControls";
import { useToast } from "../components/Toast";
import {
  type ProfileSummary,
  type SystemDialogKind,
  type UpdateCheckResult,
  addProfile,
  checkForUpdates,
  getAppVersion,
  getSettingsSummary,
  isBridgeAvailable,
  listProfiles,
  openExternalUrl,
  openSystemDialog,
  removeProfile,
  switchProfile,
  updateSettings,
} from "../lib/bridge";

const BRIDGE_AVAILABLE = isBridgeAvailable();

export function SettingsPage() {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const toast = useToast();
  const profilesQuery = useQuery({
    queryKey: ["ops-profiles"],
    queryFn: listProfiles,
    enabled: BRIDGE_AVAILABLE,
  });
  const settingsQuery = useQuery({
    queryKey: ["ops-settings"],
    queryFn: getSettingsSummary,
    enabled: BRIDGE_AVAILABLE,
  });

  const profiles = profilesQuery.data ?? [];
  const settings = settingsQuery.data;

  const versionQuery = useQuery({
    queryKey: ["app-version"],
    queryFn: getAppVersion,
    enabled: BRIDGE_AVAILABLE,
  });

  const [checking, setChecking] = useState(false);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);

  async function handleCheckForUpdates() {
    setChecking(true);
    try {
      const result = await checkForUpdates();
      setUpdateResult(result);
      if (!result.ok) {
        toast.push(result.error ?? t("settings:toasts.checkFailed"), "danger");
      } else if (result.update_available) {
        toast.push(t("settings:toasts.newVersion", { version: result.latest_version }), "success");
      } else {
        toast.push(t("settings:toasts.upToDate"), "success");
      }
    } catch (err) {
      toast.push(t("settings:toasts.checkException", { message: (err as Error).message }), "danger");
    } finally {
      setChecking(false);
    }
  }

  async function runAction(label: string, action: () => Promise<{ ok: boolean; error?: string }>) {
    try {
      const result = await action();
      if (!result.ok) {
        toast.push(t("settings:toasts.actionFailed", { label, error: result.error ?? t("common:unknownError") }), "danger");
      } else {
        toast.push(t("settings:toasts.actionRequested", { label }), "success");
        queryClient.invalidateQueries({ queryKey: ["ops-profiles"] });
      }
    } catch (err) {
      toast.push(t("settings:toasts.actionException", { label, message: (err as Error).message }), "danger");
    }
  }

  async function openDialog(kind: SystemDialogKind, label: string) {
    await runAction(label, () => openSystemDialog(kind));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <section style={{ display: "flex", flexDirection: "column", gap: 16, padding: "18px 24px", minHeight: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Card
            title={t("settings:cardProfiles")}
            actions={<ProfileAddButton onAdd={(name) => runAction(t("settings:actions.addProfile"), () => addProfile(name))} />}
          >
            <DataTable<ProfileSummary>
              rows={profiles}
              rowKey={(row) => row.id}
              columns={profileColumnsFor(
                (p) => runAction(t("settings:actions.switchProfile", { name: p.name }), () => switchProfile(p.id)),
                (p) => runAction(t("settings:actions.deleteProfile", { name: p.name }), () => removeProfile(p.id, true)),
                t,
              )}
              maxHeight={320}
            />
          </Card>
          <Card title={t("settings:cardSettings")}>
            <SettingsForm
              settings={settings}
              onSubmit={(payload) =>
                runAction(t("settings:actions.saveSettings"), async () => {
                  const result = await updateSettings(payload);
                  queryClient.invalidateQueries({ queryKey: ["ops-settings"] });
                  return result;
                })
              }
            />
          </Card>
        </div>

        <LicenseConfigCard />

        <Card title={t("settings:version.card")}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ fontSize: 13 }}>
              {t("settings:version.currentLabel")}{" "}
              <strong>{versionQuery.data?.version ?? "—"}</strong>
            </div>
            <button
              style={{ ...secondaryButtonStyle, opacity: checking ? 0.6 : 1 }}
              disabled={checking || !BRIDGE_AVAILABLE}
              onClick={handleCheckForUpdates}
            >
              {checking ? t("settings:version.checking") : t("settings:version.checkLatest")}
            </button>
          </div>

          {updateResult?.ok && updateResult.update_available && (
            <div
              style={{
                marginTop: 12,
                padding: 12,
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--surface-2, rgba(0,0,0,0.03))",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ fontSize: 13 }}>
                {t("settings:version.newVersionPrefix")}
                <strong>{updateResult.latest_version}</strong>
                {t("settings:version.newVersionSuffix", {
                  pre: updateResult.prerelease ? t("settings:version.prerelease") : "",
                })}
              </div>
              {updateResult.notes && (
                <pre
                  style={{
                    margin: 0,
                    maxHeight: 160,
                    overflow: "auto",
                    fontSize: 11,
                    whiteSpace: "pre-wrap",
                    color: "var(--text-muted)",
                  }}
                >
                  {updateResult.notes}
                </pre>
              )}
              {updateResult.release_url && (
                <div>
                  <button
                    style={secondaryButtonStyle}
                    onClick={() => openExternalUrl(updateResult.release_url!)}
                  >
                    {t("settings:version.openDownload")}
                  </button>
                </div>
              )}
            </div>
          )}

          {updateResult?.ok && !updateResult.update_available && (
            <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-muted)" }}>
              {t("settings:version.upToDate")}
            </div>
          )}

          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
            {t("settings:version.githubHint")}
          </div>
        </Card>

        <Card title={t("settings:advanced.card")}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button style={secondaryButtonStyle} onClick={() => openDialog("settings", t("settings:actions.openPermissions"))}>
              {t("settings:advanced.permissions")}
            </button>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
            {t("settings:advanced.hint")}
          </div>
        </Card>

        {!BRIDGE_AVAILABLE && (
          <div className="empty-state">{t("settings:bridgeOffline")}</div>
        )}
      </section>
    </div>
  );
}
