import type { ReactNode } from "react";
import {
  Bot,
  Coins,
  FileSearch,
  KeyRound,
  MessageSquareText,
  ShieldAlert,
  Activity,
  type LucideIcon,
} from "lucide-react";

import { Card } from "../components/Card";

interface SourceSpec {
  icon: LucideIcon;
  color: string;
  title: string;
  summary: string;
  technology: string;
  data: string[];
  permissions: string[];
  constraints: string[];
  viewIn: string;
}

const SOURCES: SourceSpec[] = [
  {
    icon: MessageSquareText,
    color: "#60a5fa",
    title: "대화 수집(API)",
    summary: "Microsoft Graph API로 사용자별 Copilot 대화 본문을 직접 수집합니다.",
    technology:
      "Microsoft Graph (beta) · getAllEnterpriseInteractions · 앱 전용(client credentials) 토큰",
    data: [
      "프롬프트/응답 본문 텍스트",
      "앱 출처(BizChat, Word, Teams, Excel, PowerPoint, Outlook, Loop 등)",
      "첨부·링크·멘션 메타데이터, 원본 JSON",
    ],
    permissions: [
      "AiEnterpriseInteraction.Read.All",
      "User.Read.All",
      "Organization.Read.All",
    ],
    constraints: [
      "Copilot 라이선스를 보유한 사용자만 대상(범위 설정에 따라 전체/라이선스/그룹/사용자 지정)",
      "beta 엔드포인트 · 사용자·기간 단위 페이징(@odata.nextLink)",
      "라이선스가 없는 사용자의 본문은 eDiscovery 경로로 별도 수집",
    ],
    viewIn: "대화 탐색(API)",
  },
  {
    icon: FileSearch,
    color: "#38bdf8",
    title: "대화 수집(e-Discovery)",
    summary: "라이선스 없는 사용자까지 포함해 Purview eDiscovery로 Copilot 본문을 복원합니다.",
    technology: "Purview eDiscovery (Graph) · 위임(delegated) 인증",
    data: [
      "라이선스 미보유 사용자를 포함한 Copilot 대화 본문",
      "케이스·검색·내보내기 산출물에서 복원한 메시지",
    ],
    permissions: [
      "eDiscovery.ReadWrite.All (위임)",
      "실행 계정에 eDiscovery Manager 역할 필요",
    ],
    constraints: [
      "앱 전용 인증은 Premium 전용이라 위임 인증 사용",
      "케이스 생성 → 검색 → 추정 → 내보내기 → 다운로드 → 해석의 비동기 단계로 진행",
      "단계별 재개(이어받기) 지원 — 중단 후 다시 시작 가능",
    ],
    viewIn: "대화 탐색(e-Discovery)",
  },
  {
    icon: Bot,
    color: "#34d399",
    title: "대화 수집(Teams)",
    summary: "Copilot Studio 커스텀 에이전트의 Teams 대화 트랜스크립트를 Dataverse에서 수집합니다.",
    technology: "Dataverse 자동 로그인(웹 자동화) · 트랜스크립트 테이블",
    data: [
      "Copilot Studio 커스텀 에이전트의 Teams 대화 기록(트랜스크립트)",
      "에이전트·환경별 대화 세션",
    ],
    permissions: [
      "환경별 Dataverse 접근(시스템 관리자 권한)",
      "PPAC/Dataverse 자동 로그인 계정",
    ],
    constraints: [
      "환경별 접근 권한이 필요 — 없는 환경은 '나를 시스템 관리자로 자동 추가' 옵션으로 처리",
      "브라우저 자동 로그인 기반이므로 MFA·세션 정책의 영향을 받음",
    ],
    viewIn: "대화 탐색(Teams)",
  },
  {
    icon: Bot,
    color: "#fbbf24",
    title: "에이전트",
    summary: "Copilot 관리 API와 감사 로그에서 에이전트 인벤토리와 실제 사용 신호를 수집합니다.",
    technology: "Microsoft Graph Copilot 관리 API(에이전트 등록·카탈로그) + 감사 로그",
    data: [
      "에이전트 인벤토리(등록 정보·카탈로그 패키지)",
      "정책 설정 신호",
      "감사 로그 기반 실제 사용 신호",
    ],
    permissions: [
      "AgentRegistration.Read.All",
      "CopilotPackages.Read.All",
      "CopilotPolicySettings.Read",
    ],
    constraints: [
      "사용 신호는 감사 로그를 기반으로 하므로 감사 이벤트 수집을 먼저 수행할수록 정확",
      "관리 API 가용 범위(테넌트 구성)에 따라 일부 항목이 비어 있을 수 있음",
    ],
    viewIn: "에이전트",
  },
  {
    icon: Coins,
    color: "#f472b6",
    title: "파워플랫폼 크레딧",
    summary: "PPAC 소비량 리포트를 내려받아 메시지·AI Builder·API 요청 사용량을 추적합니다.",
    technology: "Power Platform 관리 센터(PPAC) 자동 로그인 · 소비량 리포트 다운로드",
    data: [
      "Copilot Studio 메시지 소비량",
      "AI Builder 크레딧 소비량",
      "Power Platform 요청(API) 소비량",
    ],
    permissions: [
      "Power Platform 관리자 권한",
      "PPAC 자동 로그인 계정",
    ],
    constraints: [
      "웹 자동화 기반 — PPAC UI/리포트 가용성에 의존",
      "리포트가 제공하는 집계 기간·단위 범위 내에서만 수집",
    ],
    viewIn: "파워플랫폼 크레딧",
  },
  {
    icon: ShieldAlert,
    color: "#a78bfa",
    title: "감사 이벤트",
    summary: "Purview 통합 감사 로그와 Entra 감사/로그인에서 보안·접근 이벤트를 수집합니다.",
    technology:
      "Graph security.auditLog.queries(비동기 Purview 통합 로그) + Entra 감사/sign-in",
    data: [
      "차단/거부 등 보안 이벤트",
      "민감 자료 접근 기록",
      "접근·정책 관련 감사 이벤트",
    ],
    permissions: [
      "AuditLog.Read.All (Entra 감사·로그인)",
      "AuditLogsQuery.Read.All (Purview 통합 로그)",
      "추가로 Purview/Exchange roleManagement 역할 필요",
    ],
    constraints: [
      "Purview 감사 로그 보존 기간 내 데이터만 조회 가능",
      "통합 로그 쿼리는 비동기(제출→폴링→결과) 방식",
      "auditLog 쿼리 404 응답 시 Purview 경로는 자동 비활성화되고 Entra 경로만 사용",
    ],
    viewIn: "보안/감사",
  },
  {
    icon: Activity,
    color: "#2dd4bf",
    title: "공식 사용량",
    summary: "Microsoft 365 Copilot 공식 사용량 보고서 스냅샷을 수집합니다.",
    technology: "Microsoft Graph Reports API(Copilot 사용량 CSV)",
    data: [
      "M365 Copilot 공식 사용량 보고서 스냅샷",
      "기간별(D7/D30/D90/D180) 사용 집계",
    ],
    permissions: [
      "Reports.Read.All",
      "ReportSettings.ReadWrite.All(비익명화 설정)",
    ],
    constraints: [
      "Microsoft 보고서의 익명화 설정 영향 — 사용자 식별이 필요하면 ReportSettings로 비익명화",
      "Microsoft가 제공하는 보고 기간 단위로만 수집",
    ],
    viewIn: "공식 보고서",
  },
];

export function CollectionOverviewPage() {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <section
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 16,
          padding: "18px 24px",
          minHeight: 0,
          overflowY: "auto",
        }}
      >
        <Card title="데이터 수집 개요">
          <p style={{ margin: 0, fontSize: 13, color: "var(--text)", lineHeight: 1.7 }}>
            CopilotWatchTower는 Microsoft 365 Copilot 활동을 여러 출처에서 수집해 한 곳에서 분석합니다.
            각 수집 메뉴는 <strong>수집하는 데이터</strong>, <strong>사용하는 기술</strong>,
            그에 필요한 <strong>권한</strong>, 그리고 <strong>제약·범위</strong>가 서로 다릅니다.
            아래에서 출처별 특성을 확인한 뒤 좌측 메뉴에서 개별 수집을 실행하세요.
          </p>
        </Card>

        <Card title="인증 방식" bodyStyle={{ gap: 12 }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <KeyRound size={18} color="var(--accent)" style={{ marginTop: 2, flexShrink: 0 }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13, lineHeight: 1.6 }}>
              <div>
                <strong>부트스트랩(위임·디바이스 코드)</strong> — 최초 1회. Entra 앱 등록을 만들고
                테넌트 관리자 동의로 필요한 권한을 부여합니다.
              </div>
              <div>
                <strong>앱 전용(client credentials)</strong> — 일상 수집. 발급된 시크릿(180일 유효)으로
                Graph API를 호출합니다. eDiscovery·Teams·크레딧 일부 경로는 위임/웹 자동화 로그인을 사용합니다.
              </div>
              <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
                권한이 부족하면 <strong>설정 → 권한 업그레이드</strong>에서 누락 권한을 다시 동의하거나,
                새 프로필을 만들어 최신 권한으로 앱을 재생성할 수 있습니다.
              </div>
            </div>
          </div>
        </Card>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))",
            gap: 16,
          }}
        >
          {SOURCES.map((source) => (
            <SourceCard key={source.title} source={source} />
          ))}
        </div>
      </section>
    </div>
  );
}

function SourceCard({ source }: { source: SourceSpec }) {
  const Icon = source.icon;
  return (
    <Card
      title={
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              borderRadius: 8,
              background: `${source.color}22`,
              color: source.color,
              flexShrink: 0,
            }}
          >
            <Icon size={15} strokeWidth={2.2} />
          </span>
          {source.title}
        </span>
      }
      bodyStyle={{ gap: 12 }}
    >
      <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.6 }}>
        {source.summary}
      </p>

      <SpecBlock label="기술">
        <span style={{ fontSize: 12.5, color: "var(--text)" }}>{source.technology}</span>
      </SpecBlock>

      <SpecBlock label="수집 데이터">
        <BulletList items={source.data} />
      </SpecBlock>

      <SpecBlock label="필요 권한">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {source.permissions.map((perm) => (
            <span
              key={perm}
              style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                background: "var(--surface-2, rgba(148,163,184,0.12))",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "2px 7px",
                color: "var(--text)",
              }}
            >
              {perm}
            </span>
          ))}
        </div>
      </SpecBlock>

      <SpecBlock label="제약·범위">
        <BulletList items={source.constraints} />
      </SpecBlock>

      <div
        style={{
          marginTop: 2,
          paddingTop: 10,
          borderTop: "1px solid var(--border)",
          fontSize: 12,
          color: "var(--text-muted)",
        }}
      >
        조회 화면:{" "}
        <strong style={{ color: "var(--text)" }}>{source.viewIn}</strong>
      </div>
    </Card>
  );
}

function SpecBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--text-muted)",
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul style={{ margin: 0, paddingLeft: 16, display: "flex", flexDirection: "column", gap: 3 }}>
      {items.map((item) => (
        <li key={item} style={{ fontSize: 12.5, color: "var(--text)", lineHeight: 1.55 }}>
          {item}
        </li>
      ))}
    </ul>
  );
}
