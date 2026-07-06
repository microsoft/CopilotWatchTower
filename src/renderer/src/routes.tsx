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
  Component: ComponentType<PageProps>
  source?: string
}

export const DEFAULT_ROUTE = 'home'

export const ROUTES: Record<string, RouteDef> = {
  home: { Component: Dashboard },
  insights: { Component: Insights },
  conversationsApi: { Component: Conversations, source: 'api' },
  conversationsEdiscovery: { Component: Conversations, source: 'ediscovery' },
  conversationsDataverse: { Component: Conversations, source: 'dataverse' },
  agents: { Component: Agents },
  security: { Component: Security },
  reports: { Component: UsageCollect },
  consumption: { Component: Credits },
  agentCredit: { Component: AgentCredit },
  creditAlerts: { Component: Alerts },
  collectOverview: { Component: Collect },
  collectConversation: { Component: ConversationCollect },
  ediscovery: { Component: Ediscovery },
  collectTranscripts: { Component: TranscriptsCollect },
  collectDiagnostics: { Component: DiagnosticsCollect },
  collectConsumption: { Component: Credits },
  collectFlowRuns: { Component: FlowRunsCollect },
  collectAgentDefs: { Component: AgentDefsCollect },
  collectAudit: { Component: AuditCollect },
  collectUsage: { Component: UsageCollect },
  backupRestore: { Component: BackupRestore },
  dataExport: { Component: DataExport },
  theme: { Component: ThemeGallery },
  settings: { Component: Settings }
}
