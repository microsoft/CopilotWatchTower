import { Radio, UserRound } from "lucide-react";

import type { NavKey } from "./Sidebar";const TITLES: Record<NavKey, { title: string; subtitle: string }> = {
  home: { title: "대시보드", subtitle: "Copilot 사용 현황 및 주요 지표를 한눈에 확인하세요." },
  insights: { title: "사용 인사이트", subtitle: "사용자, 날짜, 앱 단위로 Copilot 활동을 분석합니다." },
  conversationsApi: { title: "대화 탐색(API)", subtitle: "Graph API로 수집한 운영 대화 기록만 살펴봅니다." },
  conversationsEdiscovery: { title: "대화 탐색(e-Discovery)", subtitle: "Purview eDiscovery로 복원한 대화 기록을 별도 아카이브로 살펴봅니다." },
  agents: { title: "에이전트", subtitle: "등록된 에이전트와 실제 사용 신호를 비교합니다." },
  security: { title: "보안/감사", subtitle: "차단/거부 이벤트, 민감 자료 접근, 정책 진단을 점검합니다." },
  ediscovery: {
    title: "eDiscovery 수집",
    subtitle: "라이선스 없는 사용자의 Copilot 본문을 Purview eDiscovery로 수집·재개합니다.",
  },
  reports: { title: "공식 보고서", subtitle: "Microsoft 365 Copilot 공식 사용량 보고서를 조회합니다." },
  consumption: { title: "비용/소비량", subtitle: "Copilot Studio 메시지·AI Builder 크레딧·Power Platform 요청 소비량을 추적합니다." },
  collectConversation: { title: "대화 수집", subtitle: "Graph API로 사용자 Copilot 대화를 수집·인덱싱합니다." },
  collectAudit: { title: "감사 이벤트", subtitle: "Purview·Entra 감사 로그에서 보안·접근 이벤트를 수집합니다." },
  collectUsage: { title: "공식 사용량", subtitle: "Microsoft 365 Copilot 공식 사용량 보고서 스냅샷을 수집합니다." },
  collectDiagnostics: { title: "에이전트", subtitle: "Copilot 관리 API와 감사 로그에서 에이전트 인벤토리와 사용 신호를 수집합니다." },
  collectConsumption: { title: "비용/소비량 수집", subtitle: "PPAC 자동 로그인으로 메시지·AI Builder·API 요청 소비량 리포트를 내려받습니다." },
  backupRestore: {
    title: "백업·복원",
    subtitle: "현재 프로필의 데이터를 휴대용 백업으로 만들고, 다른 백업을 현재 프로필로 불러옵니다(중복 자동 스킵).",
  },
  dataExport: {
    title: "내보내기",
    subtitle: "수집한 상호작용과 스레드를 파일로 내보내 다운로드합니다.",
  },
  settings: { title: "설정", subtitle: "프로필, 수집 주기, 범위, 시스템 다이얼로그를 관리합니다." },
};

export function ContextHeader({
  active,
  bridgeOnline,
  profileLabel,
  onManageProfile,
}: {
  active: NavKey;
  bridgeOnline: boolean;
  profileLabel: string | null;
  onManageProfile: () => void;
}) {
  const { title, subtitle } = TITLES[active];
  const profileName = profileLabel?.trim() || "프로필 미지정";
  const avatarChar = (profileLabel?.trim()?.[0] ?? "P").toUpperCase();
  return (
    <header className="topbar">
      <div>
        <h2 className="topbar-title">{title}</h2>
        <p className="topbar-subtitle">{subtitle}</p>
      </div>
      <div className="topbar-actions">
        <span className={`toolbar-chip live-pill`} title={bridgeOnline ? "Python 브리지 연결됨" : "브리지 미연결"}>
          <Radio size={14} />
          {bridgeOnline ? "라이브" : "미리보기"}
        </span>
        <button
          className="toolbar-chip profile-chip"
          type="button"
          onClick={onManageProfile}
          title={`프로필 관리 · 현재: ${profileName}`}
        >
          <span className="profile-avatar">{avatarChar}</span>
          {profileName}
          <UserRound size={14} />
        </button>
      </div>
    </header>
  );
}
