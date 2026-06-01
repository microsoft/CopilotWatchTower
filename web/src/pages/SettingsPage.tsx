import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Card } from "../components/Card";
import { DataTable } from "../components/DataTable";
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
        toast.push(result.error ?? "최신 버전을 확인하지 못했습니다.", "danger");
      } else if (result.update_available) {
        toast.push(`새 버전이 있습니다: ${result.latest_version}`, "success");
      } else {
        toast.push("최신 버전을 사용 중입니다.", "success");
      }
    } catch (err) {
      toast.push(`업데이트 확인 예외: ${(err as Error).message}`, "danger");
    } finally {
      setChecking(false);
    }
  }

  async function runAction(label: string, action: () => Promise<{ ok: boolean; error?: string }>) {
    try {
      const result = await action();
      if (!result.ok) {
        toast.push(`${label} 실패: ${result.error ?? "알 수 없는 오류"}`, "danger");
      } else {
        toast.push(`${label} 요청됨`, "success");
        queryClient.invalidateQueries({ queryKey: ["ops-profiles"] });
      }
    } catch (err) {
      toast.push(`${label} 예외: ${(err as Error).message}`, "danger");
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
            title="프로필"
            actions={<ProfileAddButton onAdd={(name) => runAction("프로필 추가", () => addProfile(name))} />}
          >
            <DataTable<ProfileSummary>
              rows={profiles}
              rowKey={(row) => row.id}
              columns={profileColumnsFor(
                (p) => runAction(`${p.name} 전환`, () => switchProfile(p.id)),
                (p) => runAction(`${p.name} 삭제`, () => removeProfile(p.id, true)),
              )}
              maxHeight={320}
            />
          </Card>
          <Card title="설정">
            <SettingsForm
              settings={settings}
              onSubmit={(payload) =>
                runAction("설정 저장", async () => {
                  const result = await updateSettings(payload);
                  queryClient.invalidateQueries({ queryKey: ["ops-settings"] });
                  return result;
                })
              }
            />
          </Card>
        </div>

        <Card title="버전 · 업데이트">
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ fontSize: 13 }}>
              현재 버전:{" "}
              <strong>{versionQuery.data?.version ?? "—"}</strong>
            </div>
            <button
              style={{ ...secondaryButtonStyle, opacity: checking ? 0.6 : 1 }}
              disabled={checking || !BRIDGE_AVAILABLE}
              onClick={handleCheckForUpdates}
            >
              {checking ? "확인 중…" : "최신 버전 확인"}
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
                새 버전 <strong>{updateResult.latest_version}</strong>
                {updateResult.prerelease ? " (프리릴리스)" : ""} 이(가) 있습니다.
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
                    다운로드 페이지 열기
                  </button>
                </div>
              )}
            </div>
          )}

          {updateResult?.ok && !updateResult.update_available && (
            <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-muted)" }}>
              최신 버전을 사용 중입니다.
            </div>
          )}

          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
            GitHub의 최신 릴리스를 확인합니다. 업데이트는 다운로드 페이지에서 직접 설치하세요.
          </div>
        </Card>

        <Card title="고급 동작">
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button style={secondaryButtonStyle} onClick={() => openDialog("settings", "권한 · 위험 영역 열기")}>
              권한 · 위험 영역…
            </button>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>
            Graph 권한 재동의, 수집 데이터 삭제, 테넌트 초기화처럼 device-code 흐름이 필요한 동작은
            안전을 위해 데스크톱 다이얼로그로 열립니다.
          </div>
        </Card>

        {!BRIDGE_AVAILABLE && (
          <div className="empty-state">브리지 미연결 상태입니다. 데스크톱 앱에서 실행하세요.</div>
        )}
      </section>
    </div>
  );
}
