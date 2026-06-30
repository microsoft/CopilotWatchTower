import type { ComponentType } from 'react'
import type { PageProps } from './types'
import { Dashboard } from './pages/Dashboard'
import { Insights } from './pages/Insights'
import { Conversations } from './pages/Conversations'
import { Agents } from './pages/Agents'
import { Security } from './pages/Security'
import { Credits } from './pages/Credits'
import { Alerts } from './pages/Alerts'
import { Collect } from './pages/Collect'
import { Ediscovery } from './pages/Ediscovery'
import { Settings } from './pages/Settings'
import { AuditCollect } from './pages/AuditCollect'
import { UsageCollect } from './pages/UsageCollect'
import { DiagnosticsCollect } from './pages/DiagnosticsCollect'
import { ConversationCollect } from './pages/ConversationCollect'
import { AgentCredit } from './pages/AgentCredit'
import { BackupRestore } from './pages/BackupRestore'
import { DataExport } from './pages/DataExport'
import { TranscriptsCollect } from './pages/TranscriptsCollect'
import { FlowRunsCollect } from './pages/FlowRunsCollect'
import { AgentDefsCollect } from './pages/AgentDefsCollect'
import { ThemeGallery } from './pages/ThemeGallery'

export interface RouteDef {
  title: string
  subtitle: string
  Component: ComponentType<PageProps>
  source?: string
}

export const DEFAULT_ROUTE = 'home'

export const ROUTES: Record<string, RouteDef> = {
  home: { title: '대시보드', subtitle: 'Copilot 사용 현황 및 주요 지표를 한눈에 확인하세요.', Component: Dashboard },
  insights: { title: '사용 인사이트', subtitle: '사용 패턴과 추세를 분석합니다.', Component: Insights },
  conversationsApi: { title: '대화 탐색(API)', subtitle: 'Graph API로 수집된 Copilot 대화를 살펴봅니다.', Component: Conversations, source: 'api' },
  conversationsEdiscovery: { title: '대화 탐색(e-Discovery)', subtitle: 'e-Discovery로 수집된 대화를 살펴봅니다.', Component: Conversations, source: 'ediscovery' },
  conversationsDataverse: { title: '대화 탐색(Teams)', subtitle: 'Teams(Dataverse) 대화를 살펴봅니다.', Component: Conversations, source: 'dataverse' },
  agents: { title: '에이전트', subtitle: '에이전트 활동과 크레딧 소비를 확인합니다.', Component: Agents },
  security: { title: '보안 / 감사', subtitle: '감사 로그와 접근 이벤트를 검토합니다.', Component: Security },
  reports: { title: '공식 보고서', subtitle: '관리 센터 공식 사용 보고서를 확인합니다.', Component: UsageCollect },
  consumption: { title: '파워플랫폼 크레딧', subtitle: '크레딧 소비와 할당을 추적합니다.', Component: Credits },
  agentCredit: { title: '에이전트 크레딧 분석', subtitle: '에이전트별 크레딧 소비를 분석합니다.', Component: AgentCredit },
  creditAlerts: { title: '크레딧 알람', subtitle: '임계값 기반 크레딧 알림을 관리합니다.', Component: Alerts },
  collectOverview: { title: '수집 개요', subtitle: '데이터 수집 상태와 소스를 관리합니다.', Component: Collect },
  collectConversation: { title: '대화 수집(API)', subtitle: 'Graph API 대화 수집 현황과 실행 기록을 확인합니다.', Component: ConversationCollect },
  ediscovery: { title: '대화 수집(e-Discovery)', subtitle: 'e-Discovery 내보내기와 가져오기를 관리합니다.', Component: Ediscovery },
  collectTranscripts: { title: '대화 수집(Teams)', subtitle: 'Teams 대화(Dataverse) 수집을 관리합니다.', Component: TranscriptsCollect },
  collectDiagnostics: { title: '에이전트 진단 수집', subtitle: 'Copilot 관리 API 진단 결과를 확인합니다.', Component: DiagnosticsCollect },
  collectConsumption: { title: '크레딧 데이터 수집', subtitle: '포털 로그인으로 파워플랫폼 크레딧 데이터를 수집합니다.', Component: Credits },
  collectFlowRuns: { title: '에이전트 실행(플로우)', subtitle: '플로우 실행 기록을 수집·확인합니다.', Component: FlowRunsCollect },
  collectAgentDefs: { title: '에이전트 위험 분석', subtitle: '에이전트 정의를 정적 분석해 위험도를 점수화합니다.', Component: AgentDefsCollect },
  collectAudit: { title: '감사 이벤트', subtitle: 'Purview·Entra 감사 이벤트 수집 상태를 확인합니다.', Component: AuditCollect },
  collectUsage: { title: '공식 사용량', subtitle: '관리 센터 공식 사용량 스냅샷을 확인합니다.', Component: UsageCollect },
  backupRestore: { title: '백업·복원', subtitle: '데이터베이스 백업과 복원을 관리합니다.', Component: BackupRestore },
  dataExport: { title: '내보내기', subtitle: '수집한 데이터를 CSV/JSON 파일로 내보냅니다.', Component: DataExport },
  theme: { title: '테마', subtitle: '색 테마를 미리보고 선택합니다.', Component: ThemeGallery },
  settings: { title: '설정', subtitle: '프로필, 테넌트, 앱 환경을 구성합니다.', Component: Settings }
}
