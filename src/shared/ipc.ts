export const INVOKE_CHANNELS = [
  'system_info',
  'dashboard_summary',
  'conversations_recent',
  'conversations_all',
  'conversation_agent_facets',
  'conversation_user_facets',
  'conversation_page',
  'conversation_users',
  'conversation_apps',
  'insights_data',
  'insights_users',
  'insights_apps',
  'top_agents',
  'agents_all',
  'agents_overview',
  'agent_identity_events',
  'conversation_thread',
  'security_overview',
  'security_events',
  'credits_overview',
  'consumption_explorer',
  'alert_rules',
  'collect_overview',
  'ediscovery_overview',
  'ediscovery_import',
  'ediscovery_collect_start',
  'ediscovery_collect_stop',
  'ediscovery_job_delete',
  'ediscovery_creds_status',
  'ediscovery_creds_set',
  'ediscovery_creds_clear',
  'audit_collect_status',
  'usage_collect_status',
  'diagnostics_status',
  'conversation_collect_status',
  'agent_credit_overview',
  'dataverse_status',
  'flow_runs_status',
  'agent_defs_status',
  'alerts_list',
  'alerts_evaluate',
  'profiles_list',
  'profile_switch',
  'profile_delete',
  'onboard_start',
  'auth_status',
  'collect_start',
  'conversation_collect_start',
  'conversation_collect_user',
  'audit_collect_start',
  'usage_collect_start',
  'diagnostics_collect_start',
  'capabilities_get',
  'capabilities_set',
  'capabilities_suggest',
  'consumption_collect_start',
  'transcripts_collect_start',
  'flowruns_collect_start',
  'agentdefs_collect_start',
  'db_stat',
  'backup_db',
  'restore_db',
  'db_wipe',
  'export_table'
] as const

export const EVENT_CHANNELS = [
  'ediscovery_progress',
  'onboard_progress',
  'onboard_device_code',
  'collect_progress',
  'conversation_progress',
  'audit_progress',
  'usage_progress',
  'diagnostics_progress',
  'consumption_progress',
  'transcripts_progress',
  'flowruns_progress',
  'agentdefs_progress'
] as const

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number]
export type EventChannel = (typeof EVENT_CHANNELS)[number]

const invokeChannels = new Set<string>(INVOKE_CHANNELS)
const eventChannels = new Set<string>(EVENT_CHANNELS)

export function isInvokeChannel(channel: string): channel is InvokeChannel {
  return invokeChannels.has(channel)
}

export function isEventChannel(channel: string): channel is EventChannel {
  return eventChannels.has(channel)
}