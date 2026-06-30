import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { Card } from "../components/Card";
import { Column, DataTable } from "../components/DataTable";
import { useToast } from "../components/Toast";
import {
  type CreditAlert,
  type CreditAlertRule,
  acknowledgeCreditAlert,
  getCreditAlertRules,
  isBridgeAvailable,
  listCreditAlerts,
  updateCreditAlertRule,
} from "../lib/bridge";
import { formatNumber } from "../lib/format";

const BRIDGE_AVAILABLE = isBridgeAvailable();

type TabKey = "active" | "history" | "rules";
const TABS: TabKey[] = ["active", "history", "rules"];

function severityColor(sev: string): string {
  return sev === "danger" ? "var(--danger)" : "var(--warn)";
}

function scopeLabel(a: CreditAlert, tenantLabel: string): string {
  if (a.scope_type === "tenant") return tenantLabel;
  return a.scope_label ?? a.scope_id ?? "—";
}

export function CreditAlertsPage() {
  const { t } = useTranslation("creditGov");
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabKey>("active");

  const activeQuery = useQuery({
    queryKey: ["credit-alerts", "active"],
    queryFn: () => listCreditAlerts("active", 300),
    enabled: BRIDGE_AVAILABLE && (tab === "active"),
    refetchInterval: 8000,
  });
  const historyQuery = useQuery({
    queryKey: ["credit-alerts", "all"],
    queryFn: () => listCreditAlerts(null, 300),
    enabled: BRIDGE_AVAILABLE && tab === "history",
  });
  const rulesQuery = useQuery({
    queryKey: ["credit-alert-rules"],
    queryFn: getCreditAlertRules,
    enabled: BRIDGE_AVAILABLE && tab === "rules",
  });

  async function ack(id: string | null, all = false) {
    const result = await acknowledgeCreditAlert(id, all);
    if (result.ok) {
      toast.push(t("alerts.ackDone"), "success");
      queryClient.invalidateQueries({ queryKey: ["credit-alerts"] });
      queryClient.invalidateQueries({ queryKey: ["credit-alerts-overview"] });
    }
  }

  const alertColumns = useMemo(
    () => buildAlertColumns(t, (id) => ack(id), tab === "active"),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, tab],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div
        style={{
          display: "flex",
          gap: 8,
          padding: "12px 24px",
          background: "var(--surface)",
          borderBottom: "1px solid var(--border)",
          alignItems: "center",
        }}
      >
        {TABS.map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className="toolbar-chip"
            style={{
              fontWeight: tab === key ? 700 : 500,
              borderColor: tab === key ? "var(--accent)" : "var(--border)",
              color: tab === key ? "var(--accent)" : "var(--text)",
            }}
          >
            {t(`alerts.tabs.${key}`)}
          </button>
        ))}
        {tab === "active" && (activeQuery.data?.alerts.length ?? 0) > 0 && (
          <button
            onClick={() => ack(null, true)}
            className="toolbar-chip"
            style={{ marginLeft: "auto", fontWeight: 600 }}
          >
            {t("alerts.acknowledgeAll")}
          </button>
        )}
      </div>

      <section style={{ display: "flex", flexDirection: "column", gap: 16, padding: "18px 24px", minHeight: 0, overflowY: "auto" }}>
        {tab === "active" && (
          <Card title={t("alerts.tabs.active")}>
            <DataTable<CreditAlert>
              columns={alertColumns}
              rows={activeQuery.data?.alerts ?? []}
              rowKey={(r) => r.id}
              empty={t("alerts.empty")}
              maxHeight="65vh"
            />
          </Card>
        )}
        {tab === "history" && (
          <Card title={t("alerts.tabs.history")}>
            <DataTable<CreditAlert>
              columns={alertColumns}
              rows={historyQuery.data?.alerts ?? []}
              rowKey={(r) => r.id}
              empty={t("alerts.emptyHistory")}
              maxHeight="65vh"
            />
          </Card>
        )}
        {tab === "rules" && (
          <RulesEditor rules={rulesQuery.data ?? []} />
        )}
      </section>
    </div>
  );
}

function buildAlertColumns(
  t: TFunction,
  onAck: (id: string) => void,
  showAck: boolean,
): Column<CreditAlert>[] {
  const cols: Column<CreditAlert>[] = [
    {
      key: "severity",
      header: t("alerts.columns.severity"),
      cell: (r) => (
        <span style={{ color: severityColor(r.severity), fontWeight: 700 }}>{t(`severity.${r.severity}`)}</span>
      ),
      sortValue: (r) => (r.severity === "danger" ? 1 : 0),
    },
    { key: "tier", header: t("alerts.columns.tier"), cell: (r) => t(`tiers.${r.tier}`) },
    { key: "rule", header: t("alerts.columns.rule"), cell: (r) => t(`alerts.ruleNames.${r.rule_key}`, r.rule_key) },
    { key: "scope", header: t("alerts.columns.scope"), cell: (r) => scopeLabel(r, t("alerts.scopeTenant")) },
    { key: "metric", header: t("alerts.columns.metric"), align: "right", cell: (r) => formatNumber(r.metric ?? 0), sortValue: (r) => r.metric ?? 0 },
    { key: "threshold", header: t("alerts.columns.threshold"), align: "right", cell: (r) => formatNumber(r.threshold ?? 0) },
    { key: "date", header: t("alerts.columns.date"), cell: (r) => r.usage_date ?? "—" },
    {
      key: "status",
      header: t("alerts.columns.status"),
      cell: (r) => (r.status === "acknowledged" ? t("alerts.acknowledged") : t("alerts.tabs.active")),
    },
  ];
  if (showAck) {
    cols.push({
      key: "ack",
      header: "",
      cell: (r) => (
        <button
          className="toolbar-chip"
          style={{ fontSize: 11, padding: "2px 10px" }}
          onClick={(e) => {
            e.stopPropagation();
            onAck(r.id);
          }}
        >
          {t("alerts.acknowledge")}
        </button>
      ),
    });
  }
  return cols;
}

function RulesEditor({ rules }: { rules: CreditAlertRule[] }) {
  const { t } = useTranslation("creditGov");
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<string, Partial<CreditAlertRule>>>({});

  function patch(key: string, change: Partial<CreditAlertRule>) {
    setDraft((prev) => ({ ...prev, [key]: { ...prev[key], ...change } }));
  }

  async function save(rule: CreditAlertRule) {
    const d = draft[rule.rule_key] ?? {};
    const result = await updateCreditAlertRule({
      rule_key: rule.rule_key,
      enabled: d.enabled ?? rule.enabled,
      threshold: d.threshold ?? rule.threshold ?? undefined,
      secondary: d.secondary ?? rule.secondary ?? undefined,
      severity: d.severity ?? rule.severity,
    });
    if (result.ok) {
      toast.push(t("alerts.saved"), "success");
      setDraft((prev) => {
        const next = { ...prev };
        delete next[rule.rule_key];
        return next;
      });
      queryClient.invalidateQueries({ queryKey: ["credit-alert-rules"] });
    } else {
      toast.push(t("alerts.saveFailed", { error: result.error ?? "" }), "danger");
    }
  }

  return (
    <Card title={t("alerts.tabs.rules")}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {rules.map((rule) => {
          const d = draft[rule.rule_key] ?? {};
          const enabled = d.enabled ?? rule.enabled;
          return (
            <div
              key={rule.rule_key}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 70px 110px 110px 120px 70px",
                gap: 10,
                alignItems: "center",
                padding: "8px 10px",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm, 8px)",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{t(`alerts.ruleNames.${rule.rule_key}`, rule.rule_key)}</div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", overflowWrap: "anywhere" }}>
                  {t(`alerts.ruleHints.${rule.rule_key}`, "")}
                </div>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => patch(rule.rule_key, { enabled: e.target.checked })}
                />
                {t("alerts.ruleColumns.enabled")}
              </label>
              <input
                type="number"
                value={d.threshold ?? rule.threshold ?? 0}
                onChange={(e) => patch(rule.rule_key, { threshold: Number(e.target.value) })}
                style={inputStyle}
                title={t("alerts.ruleColumns.threshold")}
              />
              <input
                type="number"
                value={d.secondary ?? rule.secondary ?? 0}
                onChange={(e) => patch(rule.rule_key, { secondary: Number(e.target.value) })}
                style={inputStyle}
                title={t("alerts.ruleColumns.secondary")}
              />
              <select
                value={d.severity ?? rule.severity}
                onChange={(e) => patch(rule.rule_key, { severity: e.target.value as CreditAlertRule["severity"] })}
                style={inputStyle}
                title={t("alerts.ruleColumns.severity")}
                aria-label={t("alerts.ruleColumns.severity")}
              >
                <option value="warn">{t("severity.warn")}</option>
                <option value="danger">{t("severity.danger")}</option>
              </select>
              <button className="toolbar-chip" style={{ fontWeight: 600 }} onClick={() => save(rule)}>
                {t("alerts.save")}
              </button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "4px 8px",
  fontSize: 12,
  color: "var(--text)",
  width: "100%",
};
