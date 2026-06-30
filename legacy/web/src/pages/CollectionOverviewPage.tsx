import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
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
  id: string;
  icon: LucideIcon;
  color: string;
}

const SOURCES: SourceSpec[] = [
  { id: "conversationApi", icon: MessageSquareText, color: "#60a5fa" },
  { id: "ediscovery", icon: FileSearch, color: "#38bdf8" },
  { id: "transcripts", icon: Bot, color: "#34d399" },
  { id: "agents", icon: Bot, color: "#fbbf24" },
  { id: "consumption", icon: Coins, color: "#f472b6" },
  { id: "audit", icon: ShieldAlert, color: "#a78bfa" },
  { id: "usage", icon: Activity, color: "#2dd4bf" },
];

export function CollectionOverviewPage() {
  const { t } = useTranslation("collectionOverview");
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
        <Card title={t("cards.overview")}>
          <p style={{ margin: 0, fontSize: 13, color: "var(--text)", lineHeight: 1.7 }}>
            {t("intro.lead")}
            <strong>{t("intro.strongData")}</strong>
            {t("intro.sep1")}
            <strong>{t("intro.strongTechnology")}</strong>
            {t("intro.sep2")}
            <strong>{t("intro.strongPermissions")}</strong>
            {t("intro.sep3")}
            <strong>{t("intro.strongConstraints")}</strong>
            {t("intro.tail")}
          </p>
        </Card>

        <Card title={t("cards.auth")} bodyStyle={{ gap: 12 }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <KeyRound size={18} color="var(--accent)" style={{ marginTop: 2, flexShrink: 0 }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 13, lineHeight: 1.6 }}>
              <div>
                <strong>{t("auth.bootstrap.strong")}</strong>
                {t("auth.bootstrap.text")}
              </div>
              <div>
                <strong>{t("auth.appOnly.strong")}</strong>
                {t("auth.appOnly.text")}
              </div>
              <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
                {t("auth.insufficient.prefix")}
                <strong>{t("auth.insufficient.strong")}</strong>
                {t("auth.insufficient.suffix")}
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
            <SourceCard key={source.id} source={source} />
          ))}
        </div>
      </section>
    </div>
  );
}

function SourceCard({ source }: { source: SourceSpec }) {
  const { t } = useTranslation("collectionOverview");
  const Icon = source.icon;
  const base = `sources.${source.id}`;
  const data = t(`${base}.data`, { returnObjects: true }) as unknown as string[];
  const permissions = t(`${base}.permissions`, { returnObjects: true }) as unknown as string[];
  const constraints = t(`${base}.constraints`, { returnObjects: true }) as unknown as string[];
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
          {t(`${base}.title`)}
        </span>
      }
      bodyStyle={{ gap: 12 }}
    >
      <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.6 }}>
        {t(`${base}.summary`)}
      </p>

      <SpecBlock label={t("spec.technology")}>
        <span style={{ fontSize: 12.5, color: "var(--text)" }}>{t(`${base}.technology`)}</span>
      </SpecBlock>

      <SpecBlock label={t("spec.data")}>
        <BulletList items={data} />
      </SpecBlock>

      <SpecBlock label={t("spec.permissions")}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {permissions.map((perm) => (
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

      <SpecBlock label={t("spec.constraints")}>
        <BulletList items={constraints} />
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
        {t("viewInLabel")}{" "}
        <strong style={{ color: "var(--text)" }}>{t(`${base}.viewIn`)}</strong>
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
