import { useState } from 'react'
import { Code2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

function pretty(data: unknown): string {
  if (data == null) return ''
  if (typeof data === 'string') {
    try {
      return JSON.stringify(JSON.parse(data), null, 2)
    } catch {
      return data
    }
  }
  return JSON.stringify(data, null, 2)
}

export function RawJsonButton({ data, title }: { data: unknown; title?: string }): JSX.Element {
  const { t } = useTranslation('rawJson')
  const resolvedTitle = title ?? t('defaultTitle')
  const [open, setOpen] = useState(false)
  const text = pretty(data)
  return (
    <>
      <button
        type="button"
        className="rawjson-btn"
        title={resolvedTitle}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
      >
        <Code2 size={14} />
      </button>
      {open && (
        <div
          className="rawjson-overlay"
          role="presentation"
          onClick={() => setOpen(false)}
        >
          <div className="rawjson-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="rawjson-head">
              <span>{resolvedTitle}</span>
              <button type="button" className="rawjson-close" onClick={() => setOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <pre className="rawjson-body">{text || t('empty')}</pre>
          </div>
        </div>
      )}
    </>
  )
}
