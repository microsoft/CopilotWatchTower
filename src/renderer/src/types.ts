export interface SystemInfo {
  app: string
  profile: string
  tenant: string
  version: string
}

export interface PageProps {
  info: SystemInfo | null
  source?: string
  onAddProfile?: () => void
  onNavigate?: (key: string) => void
  themeId?: string
  onThemeChange?: (id: string) => void
}
