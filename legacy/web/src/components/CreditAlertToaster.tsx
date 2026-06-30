import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { useToast } from "./Toast";
import { isBridgeAvailable, subscribeBridgeEvents } from "../lib/bridge";

/**
 * Headless listener: when the backend re-evaluates the credit alert rules
 * after a credit-signal collection and finds new alerts, surface a toast and
 * refresh the alert queries (banner + lists). Renders nothing.
 */
export function CreditAlertToaster() {
  const { t } = useTranslation("creditGov");
  const toast = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!isBridgeAvailable()) return;
    let unsubscribe: (() => void) | null = null;
    subscribeBridgeEvents((event) => {
      if (event.type !== "credit_alerts.updated") return;
      queryClient.invalidateQueries({ queryKey: ["credit-alerts-overview"] });
      queryClient.invalidateQueries({ queryKey: ["credit-alerts"] });
      const added = Number((event.payload as Record<string, unknown>)?.new ?? 0);
      if (added > 0) {
        toast.push(t("toastNew", { count: added }), "danger", 7000);
      }
    })
      .then((off) => {
        unsubscribe = off;
      })
      .catch(() => undefined);
    return () => unsubscribe?.();
  }, [t, toast, queryClient]);

  return null;
}
