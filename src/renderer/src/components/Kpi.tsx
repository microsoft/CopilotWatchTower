export function Kpi({
  icon,
  label,
  value,
  foot,
  delta,
  tone
}: {
  icon: JSX.Element
  label: string
  value: string
  foot?: string
  delta?: string
  tone?: 'danger' | 'positive' | 'warn'
}): JSX.Element {
  return (
    <div className={`card kpi${tone ? ` kpi-${tone}` : ''}`}>
      <div className="kpi-accent" />
      <div className="kpi-label">
        {icon}
        {label}
      </div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-foot">
        {delta && <span className="kpi-delta">{delta}</span>} {foot}
      </div>
    </div>
  )
}
