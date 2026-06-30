import { useState } from 'react'
import { Code2, X } from 'lucide-react'

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

export function RawJsonButton({ data, title = '원본 JSON' }: { data: unknown; title?: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const text = pretty(data)
  return (
    <>
      <button
        type="button"
        className="rawjson-btn"
        title={title}
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
              <span>{title}</span>
              <button type="button" className="rawjson-close" onClick={() => setOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <pre className="rawjson-body">{text || '(비어 있음)'}</pre>
          </div>
        </div>
      )}
    </>
  )
}
