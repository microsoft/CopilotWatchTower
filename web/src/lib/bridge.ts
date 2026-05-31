// Typed wrapper around the QWebChannel-exposed Python bridge.
//
// Slots on the Python side are async by nature (they accept a callback
// as the last argument). We adapt every slot to a Promise so React Query
// can drive the data fetching.

export interface AnalyticsFilters {
  date_from?: string | null;
  date_to?: string | null;
  user_id?: string | null;
  app?: string | null;
  search?: string | null;
  limit?: number | null;
  source_type?: "api" | "ediscovery" | null;
}

export interface UserActivityOverviewRow {
  user_id: string;
  display_name: string | null;
  upn: string | null;
  enabled: boolean;
  licensed: boolean;
  active_days: number;
  thread_count: number;
  message_count: number;
  prompt_count: number;
  response_count: number;
  app_count: number;
  top_app: string;
  top_app_raw: string;
  last_activity_at: string | null;
}

export interface UserDailyActivityRow {
  user_id: string;
  display_name: string | null;
  upn: string | null;
  day: string;
  thread_count: number;
  message_count: number;
  prompt_count: number;
  response_count: number;
  app_count: number;
  top_app: string;
  top_app_raw: string;
  last_activity_at: string | null;
}

export interface UserDailyAppUsageRow {
  user_id: string;
  display_name: string | null;
  upn: string | null;
  day: string;
  app: string;
  app_raw: string;
  thread_count: number;
  message_count: number;
  prompt_count: number;
  response_count: number;
}

export interface AppOption {
  value: string;
  label: string;
}

export interface UserSummary {
  id: string;
  upn: string | null;
  display_name: string | null;
  enabled: boolean;
  licensed: boolean;
}

export interface SystemInfo {
  app: string;
  profile: string | null;
  profile_id: string | null;
}

export interface ConversationThreadSummary {
  id: string;
  user_id: string;
  display_name: string | null;
  upn: string | null;
  started_at: string;
  ended_at: string;
  app: string;
  app_raw: string;
  turn_count: number;
  prompt_count: number;
  response_count: number;
  title: string;
  topic_keywords: string[];
  session_ids: string[];
  source_type: "api" | "ediscovery";
}

export interface ConversationTurn {
  id: string;
  created_at: string;
  interaction_type: string;
  app: string;
  app_raw: string;
  session_id: string | null;
  body_text: string;
  body_content_type: string;
  source_type: "api" | "ediscovery";
}

export interface ConversationAuditEvent {
  id: string;
  source: string;
  event_time: string;
  upn: string | null;
  operation: string | null;
  workload: string | null;
  app: string;
  app_raw: string;
  result: string | null;
}

export interface ConversationDetail {
  thread: ConversationThreadSummary | null;
  turns: ConversationTurn[];
  audit: ConversationAuditEvent[];
}

export interface ConversationFilters {
  date_from?: string | null;
  date_to?: string | null;
  user_id?: string | null;
  app?: string | null;
  search?: string | null;
  limit?: number | null;
  source_type?: "api" | "ediscovery" | null;
}

export interface AgentFilters {
  threshold_days?: number | null;
  include_all?: boolean | null;
  search?: string | null;
}

export interface AgentRow {
  id: string;
  display_name: string | null;
  app_identity: string | null;
  app_external_id: string | null;
  add_on_guid: string | null;
  source: string;
  status: string | null;
  last_activity_at: string | null;
  last_activity_source: string | null;
  usage_event_count: number;
  state: "active" | "stale" | "never_used";
  is_stale: boolean;
  days_inactive: number | null;
  confidence: "ok" | "limited_audit_window" | "no_audit_data";
  threshold_days: number;
  audit_coverage_start: string | null;
  audit_coverage_end: string | null;
}

export type AuditSource = "purview" | "entra_audit" | "entra_signin";

export interface AuditEventFilters {
  source?: AuditSource | null;
  user_id?: string | null;
  date_from?: string | null;
  date_to?: string | null;
  search?: string | null;
  limit?: number | null;
}

export interface AuditEventRow {
  id: string;
  source: AuditSource | string;
  event_time: string;
  user_id: string | null;
  upn: string | null;
  operation: string | null;
  workload: string | null;
  app: string;
  app_raw: string;
  client_ip: string | null;
  target_resources: string | null;
  result: string | null;
  raw_json: string | null;
  fetched_at: string | null;
}

export interface AdminDiagnosticRow {
  key: string;
  label: string;
  endpoint: string;
  status: string;
  status_code: number | null;
  summary: string | null;
  error: string | null;
  captured_at: string;
}

export type UsagePeriod = "D7" | "D30" | "D90" | "D180";

export interface UsageSnapshotFilters {
  period?: UsagePeriod | null;
  date_from?: string | null;
  date_to?: string | null;
  search?: string | null;
  limit?: number | null;
}

export interface UsageSnapshotRow {
  snapshot_date: string;
  user_id: string | null;
  upn: string | null;
  period: string;
  display_name: string | null;
  last_activity_overall: string | null;
  last_activity_teams: string | null;
  last_activity_word: string | null;
  last_activity_excel: string | null;
  last_activity_powerpoint: string | null;
  last_activity_outlook: string | null;
  last_activity_onenote: string | null;
  last_activity_loop: string | null;
  last_activity_bizchat: string | null;
}

export type UsageReportType = "summary" | "trend";

export interface UsageCountFilters {
  report_type?: UsageReportType | null;
  period?: UsagePeriod | null;
  limit?: number | null;
}

export interface UsageCountRow {
  report_type: string;
  report_refresh_date: string;
  period: string;
  report_date: string | null;
  any_app_enabled_users: number | null;
  any_app_active_users: number | null;
  teams_enabled_users: number | null;
  teams_active_users: number | null;
  word_enabled_users: number | null;
  word_active_users: number | null;
  powerpoint_enabled_users: number | null;
  powerpoint_active_users: number | null;
  outlook_enabled_users: number | null;
  outlook_active_users: number | null;
  excel_enabled_users: number | null;
  excel_active_users: number | null;
  onenote_enabled_users: number | null;
  onenote_active_users: number | null;
  loop_enabled_users: number | null;
  loop_active_users: number | null;
  copilot_chat_enabled_users: number | null;
  copilot_chat_active_users: number | null;
}

export interface UsagePeriodsSummary {
  latest_snapshot_dates: Record<UsagePeriod, string | null>;
}

export interface CollectionRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  users_processed: number;
  interactions_fetched: number;
  errors_count: number;
  trigger: string;
}

export interface AuditCollectionStateRow {
  source: string;
  last_collected_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  last_record_count: number;
  pending_query_id: string | null;
  enabled: boolean;
}

export interface OperationsSummary {
  users: { total: number; readiness: Record<string, number> };
  interactions: number;
  threads: number;
}

export interface ProfileSummary {
  id: string;
  name: string;
  tenant_domain: string | null;
  display_name: string | null;
  bootstrap_complete: boolean;
  last_used_at: string;
  created_at: string;
  active: boolean;
  current: boolean;
}

export interface SettingsSummary {
  tenant_id: string | null;
  client_id: string | null;
  secret_expires_at: string | null;
  language: string | null;
  poll_interval_minutes: number | null;
  scope_mode: string | null;
  scope_group_id: string | null;
  scope_upns: string[];
  bootstrap_complete: boolean;
}

interface RawBridge {
  system_info(cb: (raw: string) => void): void;
  analytics_user_activity_overview(filters: string, cb: (raw: string) => void): void;
  analytics_user_daily_activity(filters: string, cb: (raw: string) => void): void;
  analytics_user_daily_app_usage(filters: string, cb: (raw: string) => void): void;
  analytics_interaction_apps(filters: string, cb: (raw: string) => void): void;
  users_in_scope(cb: (raw: string) => void): void;
  ediscovery_users(cb: (raw: string) => void): void;
  conversations_list(filters: string, cb: (raw: string) => void): void;
  conversations_detail(thread_id: string, cb: (raw: string) => void): void;
  agents_list(filters: string, cb: (raw: string) => void): void;
  audit_events_list(filters: string, cb: (raw: string) => void): void;
  admin_diagnostics_list(cb: (raw: string) => void): void;
  usage_snapshots_list(filters: string, cb: (raw: string) => void): void;
  usage_counts_list(filters: string, cb: (raw: string) => void): void;
  usage_periods_summary(cb: (raw: string) => void): void;
  operations_recent_runs(filters: string, cb: (raw: string) => void): void;
  operations_audit_state(cb: (raw: string) => void): void;
  operations_summary(cb: (raw: string) => void): void;
  profiles_list(cb: (raw: string) => void): void;
  settings_summary(cb: (raw: string) => void): void;
  collection_start(kind: string, cb: (raw: string) => void): void;
  collection_stop(kind: string, cb: (raw: string) => void): void;
  collection_status(cb: (raw: string) => void): void;
  ediscovery_collect_start(payload: string, cb: (raw: string) => void): void;
  ediscovery_collect_stop(target_upn: string, cb: (raw: string) => void): void;
  ediscovery_collect_status(cb: (raw: string) => void): void;
  ediscovery_open_download(job_id: string, cb: (raw: string) => void): void;
  ediscovery_import_export(job_id: string, cb: (raw: string) => void): void;
  profile_switch(profile_id: string, cb: (raw: string) => void): void;
  profile_add(name: string, cb: (raw: string) => void): void;
  profile_remove(profile_id: string, delete_data_json: string, cb: (raw: string) => void): void;
  settings_update(payload: string, cb: (raw: string) => void): void;
  open_system_dialog(kind: string, cb: (raw: string) => void): void;
  diagnostics_ping(cb: (raw: string) => void): void;
  bridge_event: BridgeSignal;
}

interface BridgeSignal {
  connect(handler: (payload: string) => void): void;
  disconnect(handler: (payload: string) => void): void;
}

let bridgePromise: Promise<RawBridge> | null = null;

function loadBridge(): Promise<RawBridge> {
  if (bridgePromise) return bridgePromise;
  bridgePromise = new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("Bridge unavailable: not running in a browser context"));
      return;
    }
    const transport = window.qt?.webChannelTransport;
    const QWebChannelCtor = window.QWebChannel;
    if (!transport || !QWebChannelCtor) {
      reject(
        new Error(
          "QWebChannel transport not available. Launch the desktop app with --web, or set COPILOT_WATCHTOWER_WEB_DEV_URL.",
        ),
      );
      return;
    }
    new QWebChannelCtor(transport, (channel) => {
      const wt = channel.objects.watchtower as RawBridge | undefined;
      if (!wt) {
        reject(new Error("Bridge object 'watchtower' was not registered."));
        return;
      }
      resolve(wt);
    });
  });
  return bridgePromise;
}

function callJson<T>(invoke: (cb: (raw: string) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      invoke((raw) => {
        try {
          resolve(JSON.parse(raw) as T);
        } catch (err) {
          reject(err);
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

export async function getSystemInfo(): Promise<SystemInfo> {
  const bridge = await loadBridge();
  return callJson<SystemInfo>((cb) => bridge.system_info(cb));
}

export async function getUsersInScope(): Promise<UserSummary[]> {
  const bridge = await loadBridge();
  return callJson<UserSummary[]>((cb) => bridge.users_in_scope(cb));
}

export async function listEdiscoveryUsers(): Promise<UserSummary[]> {
  const bridge = await loadBridge();
  return callJson<UserSummary[]>((cb) => bridge.ediscovery_users(cb));
}

export async function getInteractionApps(filters: AnalyticsFilters): Promise<AppOption[]> {
  const bridge = await loadBridge();
  return callJson<AppOption[]>((cb) => bridge.analytics_interaction_apps(JSON.stringify(filters), cb));
}

export async function getUserActivityOverview(
  filters: AnalyticsFilters,
): Promise<UserActivityOverviewRow[]> {
  const bridge = await loadBridge();
  return callJson<UserActivityOverviewRow[]>((cb) =>
    bridge.analytics_user_activity_overview(JSON.stringify(filters), cb),
  );
}

export async function getUserDailyActivity(
  filters: AnalyticsFilters,
): Promise<UserDailyActivityRow[]> {
  const bridge = await loadBridge();
  return callJson<UserDailyActivityRow[]>((cb) =>
    bridge.analytics_user_daily_activity(JSON.stringify(filters), cb),
  );
}

export async function getUserDailyAppUsage(
  filters: AnalyticsFilters,
): Promise<UserDailyAppUsageRow[]> {
  const bridge = await loadBridge();
  return callJson<UserDailyAppUsageRow[]>((cb) =>
    bridge.analytics_user_daily_app_usage(JSON.stringify(filters), cb),
  );
}

export function isBridgeAvailable(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.qt?.webChannelTransport && window.QWebChannel);
}

export async function listConversations(filters: ConversationFilters): Promise<ConversationThreadSummary[]> {
  const bridge = await loadBridge();
  return callJson<ConversationThreadSummary[]>((cb) =>
    bridge.conversations_list(JSON.stringify(filters), cb),
  );
}

export async function getConversationDetail(threadId: string): Promise<ConversationDetail> {
  const bridge = await loadBridge();
  return callJson<ConversationDetail>((cb) => bridge.conversations_detail(threadId, cb));
}

export async function listAgents(filters: AgentFilters): Promise<AgentRow[]> {
  const bridge = await loadBridge();
  return callJson<AgentRow[]>((cb) => bridge.agents_list(JSON.stringify(filters), cb));
}

export async function listAuditEvents(filters: AuditEventFilters): Promise<AuditEventRow[]> {
  const bridge = await loadBridge();
  return callJson<AuditEventRow[]>((cb) => bridge.audit_events_list(JSON.stringify(filters), cb));
}

export async function listAdminDiagnostics(): Promise<AdminDiagnosticRow[]> {
  const bridge = await loadBridge();
  return callJson<AdminDiagnosticRow[]>((cb) => bridge.admin_diagnostics_list(cb));
}

export async function listUsageSnapshots(filters: UsageSnapshotFilters): Promise<UsageSnapshotRow[]> {
  const bridge = await loadBridge();
  return callJson<UsageSnapshotRow[]>((cb) => bridge.usage_snapshots_list(JSON.stringify(filters), cb));
}

export async function listUsageCounts(filters: UsageCountFilters): Promise<UsageCountRow[]> {
  const bridge = await loadBridge();
  return callJson<UsageCountRow[]>((cb) => bridge.usage_counts_list(JSON.stringify(filters), cb));
}

export async function getUsagePeriodsSummary(): Promise<UsagePeriodsSummary> {
  const bridge = await loadBridge();
  return callJson<UsagePeriodsSummary>((cb) => bridge.usage_periods_summary(cb));
}

export async function listRecentRuns(limit = 50): Promise<CollectionRun[]> {
  const bridge = await loadBridge();
  return callJson<CollectionRun[]>((cb) => bridge.operations_recent_runs(JSON.stringify({ limit }), cb));
}

export async function getAuditCollectionState(): Promise<AuditCollectionStateRow[]> {
  const bridge = await loadBridge();
  return callJson<AuditCollectionStateRow[]>((cb) => bridge.operations_audit_state(cb));
}

export async function getOperationsSummary(): Promise<OperationsSummary> {
  const bridge = await loadBridge();
  return callJson<OperationsSummary>((cb) => bridge.operations_summary(cb));
}

export async function listProfiles(): Promise<ProfileSummary[]> {
  const bridge = await loadBridge();
  return callJson<ProfileSummary[]>((cb) => bridge.profiles_list(cb));
}

export async function getSettingsSummary(): Promise<SettingsSummary> {
  const bridge = await loadBridge();
  return callJson<SettingsSummary>((cb) => bridge.settings_summary(cb));
}

export type CollectionKind = "conversation" | "audit" | "usage" | "diagnostics";

export interface ActionResult {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface CollectionStatus {
  running: Array<{ kind: CollectionKind; started_at: string }>;
}

export interface SettingsUpdatePayload {
  poll_interval_minutes?: number;
  scope_mode?: string;
  scope_group_id?: string | null;
  scope_upns?: string[];
  language?: string;
}

export interface BridgeEvent {
  type: string;
  payload: Record<string, unknown>;
  at: string;
}

export async function startCollection(kind: CollectionKind): Promise<ActionResult> {
  const bridge = await loadBridge();
  return callJson<ActionResult>((cb) => bridge.collection_start(kind, cb));
}

export async function stopCollection(kind: CollectionKind): Promise<ActionResult> {
  const bridge = await loadBridge();
  return callJson<ActionResult>((cb) => bridge.collection_stop(kind, cb));
}

export async function getCollectionStatus(): Promise<CollectionStatus> {
  const bridge = await loadBridge();
  return callJson<CollectionStatus>((cb) => bridge.collection_status(cb));
}

export interface EdiscoveryJobRow {
  id: string;
  target_upn: string;
  status: string;
  window_start: string | null;
  window_end: string | null;
  interactions_added: number;
  last_error: string | null;
  updated_at: string;
  running: boolean;
  export_url?: string | null;
  /** True when the only download link is the browser-interactive proxy URL,
   *  so the operator must download in their browser and import the ZIP. */
  needs_manual_download?: boolean;
}

export interface EdiscoveryStatus {
  jobs: EdiscoveryJobRow[];
}

export interface EdiscoveryStartPayload {
  target_upn: string;
  window_start?: string | null;
  window_end?: string | null;
  /** When set, resume this exact job row instead of starting a new run. */
  job_id?: string | null;
}

export async function startEdiscoveryCollection(payload: EdiscoveryStartPayload): Promise<ActionResult> {
  const bridge = await loadBridge();
  return callJson<ActionResult>((cb) => bridge.ediscovery_collect_start(JSON.stringify(payload), cb));
}

export async function stopEdiscoveryCollection(jobId: string): Promise<ActionResult> {
  const bridge = await loadBridge();
  return callJson<ActionResult>((cb) => bridge.ediscovery_collect_stop(jobId, cb));
}

export async function getEdiscoveryStatus(): Promise<EdiscoveryStatus> {
  const bridge = await loadBridge();
  return callJson<EdiscoveryStatus>((cb) => bridge.ediscovery_collect_status(cb));
}

export async function openEdiscoveryDownload(jobId: string): Promise<ActionResult> {
  const bridge = await loadBridge();
  return callJson<ActionResult>((cb) => bridge.ediscovery_open_download(jobId, cb));
}

export async function importEdiscoveryExport(jobId: string): Promise<ActionResult> {
  const bridge = await loadBridge();
  return callJson<ActionResult>((cb) => bridge.ediscovery_import_export(jobId, cb));
}

export async function switchProfile(profileId: string): Promise<ActionResult> {
  const bridge = await loadBridge();
  return callJson<ActionResult>((cb) => bridge.profile_switch(profileId, cb));
}

export async function addProfile(name: string): Promise<ActionResult> {
  const bridge = await loadBridge();
  return callJson<ActionResult>((cb) => bridge.profile_add(name, cb));
}

export async function removeProfile(profileId: string, deleteData = true): Promise<ActionResult> {
  const bridge = await loadBridge();
  return callJson<ActionResult>((cb) => bridge.profile_remove(profileId, JSON.stringify(deleteData), cb));
}

export async function updateSettings(payload: SettingsUpdatePayload): Promise<ActionResult> {
  const bridge = await loadBridge();
  return callJson<ActionResult>((cb) => bridge.settings_update(JSON.stringify(payload), cb));
}

export type SystemDialogKind = "settings" | "permissions_upgrade" | "factory_reset";

export async function openSystemDialog(kind: SystemDialogKind): Promise<ActionResult> {
  const bridge = await loadBridge();
  return callJson<ActionResult>((cb) => bridge.open_system_dialog(kind, cb));
}

export async function pingBridge(): Promise<ActionResult> {
  const bridge = await loadBridge();
  return callJson<ActionResult>((cb) => bridge.diagnostics_ping(cb));
}

export async function subscribeBridgeEvents(handler: (event: BridgeEvent) => void): Promise<() => void> {
  const bridge = await loadBridge();
  const wrapped = (raw: string) => {
    try {
      const parsed = JSON.parse(raw) as BridgeEvent;
      handler(parsed);
      // eslint-disable-next-line no-console
      console.debug("bridge_event", parsed.type, parsed.payload);
    } catch (err) {
      console.warn("bridge_event parse failed", err, raw);
    }
  };
  bridge.bridge_event.connect(wrapped);
  return () => bridge.bridge_event.disconnect(wrapped);
}
