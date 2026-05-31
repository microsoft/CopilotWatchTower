import { useQuery, useQueryClient } from "@tanstack/react-query";

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
  addProfile,
  getSettingsSummary,
  isBridgeAvailable,
  listProfiles,
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
