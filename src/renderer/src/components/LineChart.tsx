// Dependency-free multi-series SVG line chart shared by Dashboard and Insights.
export interface LineSeries {
  key: string
  color: string
  label: string
}

function md(day: string): string {
  const parts = day.split('-')
  return parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : day
}

export function LineChart<T extends { day: string }>({
  data,
  series,
  height = 190
}: {
  data: T[]
  series: LineSeries[]
  height?: number
}): JSX.Element {
  if (data.length === 0) return <div className="empty-state">표시할 데이터가 없습니다.</div>
  const num = (d: T, key: string): number => Number((d as Record<string, number | string>)[key]) || 0
  const W = 600
  const H = 190
  const padL = 30
  const padR = 14
  const padT = 12
  const padB = 24
  const maxY = Math.max(1, ...data.flatMap((d) => series.map((s) => num(d, s.key))))
  const len = data.length
  const x = (i: number): number => padL + (len === 1 ? 0 : (i / (len - 1)) * (W - padL - padR))
  const y = (v: number): number => padT + (1 - v / maxY) * (H - padT - padB)
  const linePath = (key: string): string =>
    data.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(num(d, key)).toFixed(1)}`).join(' ')
  const gridYs = [0, 0.25, 0.5, 0.75, 1]
  const labelIdx = len <= 1 ? [0] : [0, Math.floor((len - 1) / 2), len - 1]
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="trend-svg" style={{ height }} preserveAspectRatio="none" role="img">
        {gridYs.map((f) => {
          const yy = padT + f * (H - padT - padB)
          return (
            <line
              key={f}
              x1={padL}
              y1={yy}
              x2={W - padR}
              y2={yy}
              stroke="var(--border)"
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          )
        })}
        {series.map((s) => (
          <path
            key={s.key}
            d={linePath(s.key)}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="trend-axis">
        {labelIdx.map((i) => (
          <span key={i}>{md(data[i].day)}</span>
        ))}
      </div>
      <div className="trend-legend">
        {series.map((s) => (
          <span key={s.key}>
            <i style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  )
}
