import { Bell, CalendarDays, ChevronDown, Radio, UserRound } from "lucide-react";

import { defaultDateRange } from "../lib/format";
import type { NavKey } from "./Sidebar";

const TITLES: Record<NavKey, { title: string; subtitle: string }> = {
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
  operations: { title: "수집 운영", subtitle: "수집 작업을 실행·중단하고 이력·로그·상태를 확인합니다." },
  settings: { title: "설정", subtitle: "프로필, 수집 주기, 범위, 시스템 다이얼로그를 관리합니다." },
};

export function ContextHeader({ active, bridgeOnline }: { active: NavKey; bridgeOnline: boolean }) {
  const { title, subtitle } = TITLES[active];
  const range = defaultDateRange();
  return (
    <header className="topbar">
      <div>
        <h2 className="topbar-title">{title}</h2>
        <p className="topbar-subtitle">{subtitle}</p>
      </div>
      <div className="topbar-actions">
        <span className="toolbar-chip" title="현재 보기의 기본 기간">
          <CalendarDays size={15} />
          {range.date_from} ~ {range.date_to}
          <ChevronDown size={14} />
        </span>
        <span className={`toolbar-chip live-pill`} title={bridgeOnline ? "Python 브리지 연결됨" : "브리지 미연결"}>
          <Radio size={14} />
          {bridgeOnline ? "라이브" : "미리보기"}
        </span>
        <button className="icon-button" type="button" title="알림">
          <Bell size={16} />
        </button>
        <span className="toolbar-chip profile-chip" title="현재 사용자">
          <span className="profile-avatar">A</span>
          Admin
          <UserRound size={14} />
        </span>
      </div>
    </header>
  );
}
