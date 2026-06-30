import { RefreshCw } from 'lucide-react'
import { ThemePicker } from './ThemePicker'

export function Topbar({
  title,
  subtitle,
  themeId,
  onThemeChange,
  onRefresh
}: {
  title: string
  subtitle: string
  themeId: string
  onThemeChange: (id: string) => void
  onRefresh: () => void
}): JSX.Element {
  return (
    <div className="topbar">
      <div>
        <h1>{title}</h1>
        <div className="subtitle">{subtitle}</div>
      </div>
      <div className="spacer" />
      <span className="pill live">
        <span className="dot" /> 라이브
      </span>
      <ThemePicker current={themeId} onSelect={onThemeChange} />
      <button className="btn" onClick={onRefresh}>
        <RefreshCw size={15} /> 새로고침
      </button>
    </div>
  )
}
