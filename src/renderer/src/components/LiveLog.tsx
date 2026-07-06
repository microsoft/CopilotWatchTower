import { useEffect, useRef } from 'react'
import { Terminal, Copy, Eraser, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { LogLine } from '../lib/collectRuns'

const MAX_RENDER = 800

/**
 * Real-time console for collection runs: streams log lines as they arrive,
 * sticks to the bottom while new lines come in, and offers copy / clear.
 */
export function LiveLog({
  lines,
  running = false,
  percent,
  onClear
}: {
  lines: LogLine[]
  running?: boolean
  percent?: number | null
  onClear?: () => void
}): JSX.Element {
  const { t } = useTranslation('liveLog')
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)

  useEffect(() => {
    const el = bodyRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [lines])

  function onScroll(): void {
    const el = bodyRef.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 28
  }

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(lines.map((l) => `[${l.time}] ${l.text}`).join('\n'))
    } catch {
      /* clipboard unavailable */
    }
  }

  const shown = lines.length > MAX_RENDER ? lines.slice(lines.length - MAX_RENDER) : lines
  const pct = percent == null ? null : Math.min(100, Math.max(0, Math.round(percent)))

  return (
    <div className="card livelog">
      <div className="card-head">
        <h2>
          {running ? <Loader2 size={14} className="spin" /> : <Terminal size={14} />} {t('title')}
        </h2>
        <span className="hint">
          {running ? t('status.running') : lines.length ? t('status.done') : t('status.idle')} · {t('lineCount', { count: lines.length })}
          {pct != null ? ` · ${pct}%` : ''}
        </span>
        <div className="livelog-tools">
          <button className="btn-sm" onClick={copy} disabled={!lines.length} title={t('copyTitle')}>
            <Copy size={13} /> {t('copy')}
          </button>
          {onClear && (
            <button className="btn-sm danger" onClick={onClear} disabled={!lines.length || running} title={t('clearTitle')}>
              <Eraser size={13} /> {t('clear')}
            </button>
          )}
        </div>
      </div>
      {pct != null && (
        <div className="livelog-bar">
          <div className="livelog-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="livelog-body mono" ref={bodyRef} onScroll={onScroll}>
        {shown.length === 0 ? (
          <div className="livelog-empty">{t('empty')}</div>
        ) : (
          shown.map((l, i) => (
            <div key={i} className={`livelog-line ${l.level}`}>
              <span className="livelog-time">{l.time}</span>
              <span className="livelog-text">{l.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
