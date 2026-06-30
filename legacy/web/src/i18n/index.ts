import i18n from "i18next";
import { initReactI18next } from "react-i18next";

// Eagerly load every namespace file under locales/<lng>/<ns>.json. Using a
// glob keeps the i18n bootstrap conflict-free: adding a new page namespace is
// just a matter of dropping `locales/ko/<ns>.json` + `locales/en/<ns>.json`,
// with no central registry edit.
const modules = import.meta.glob("./locales/*/*.json", { eager: true }) as Record<
  string,
  { default: Record<string, unknown> }
>;

const resources: Record<string, Record<string, Record<string, unknown>>> = {};
for (const [path, mod] of Object.entries(modules)) {
  const match = path.match(/\.\/locales\/([^/]+)\/([^/]+)\.json$/);
  if (!match) continue;
  const [, lng, ns] = match;
  (resources[lng] ??= {})[ns] = mod.default;
}

export const SUPPORTED_LANGUAGES = ["ko", "en"] as const;
export type AppLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Map a backend language code (`ko_KR`, `en_US`) to a UI language (`ko`, `en`). */
export function toI18nLanguage(backend: string | null | undefined): AppLanguage {
  return (backend ?? "").toLowerCase().startsWith("en") ? "en" : "ko";
}

/** Map a UI language (`ko`, `en`) back to a backend code (`ko_KR`, `en_US`). */
export function toBackendLanguage(lng: string | null | undefined): "ko_KR" | "en_US" {
  return (lng ?? "").toLowerCase().startsWith("en") ? "en_US" : "ko_KR";
}

const namespaces = Array.from(
  new Set(Object.values(resources).flatMap((nsMap) => Object.keys(nsMap))),
);

void i18n.use(initReactI18next).init({
  resources,
  lng: "ko",
  fallbackLng: "ko",
  ns: namespaces,
  defaultNS: "common",
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
