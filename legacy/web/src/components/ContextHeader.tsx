import { Radio, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { NavKey } from "./Sidebar";

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
  const { t } = useTranslation(["contextHeader", "common"]);
  const title = t(`titles.${active}.title`);
  const subtitle = t(`titles.${active}.subtitle`);
  const profileName = profileLabel?.trim() || t("common:profileUnset");
  const avatarChar = (profileLabel?.trim()?.[0] ?? "P").toUpperCase();
  return (
    <header className="topbar">
      <div>
        <h2 className="topbar-title">{title}</h2>
        <p className="topbar-subtitle">{subtitle}</p>
      </div>
      <div className="topbar-actions">
        <span
          className={`toolbar-chip live-pill`}
          title={bridgeOnline ? t("bridgeConnected") : t("bridgeDisconnected")}
        >
          <Radio size={14} />
          {bridgeOnline ? t("common:live") : t("common:preview")}
        </span>
        <button
          className="toolbar-chip profile-chip"
          type="button"
          onClick={onManageProfile}
          title={t("manageProfile", { name: profileName })}
        >
          <span className="profile-avatar">{avatarChar}</span>
          {profileName}
          <UserRound size={14} />
        </button>
      </div>
    </header>
  );
}
