import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { invoke } from '../lib/api'

/**
 * eDiscovery ME3 unattended-download service account. ME3 / eDiscovery Standard
 * tenants return a browser-interactive proxy download URL that rejects access
 * tokens, so a service account (no MFA) is needed to auto-fill the sign-in and
 * download with no login prompt. Stored DPAPI-encrypted in the active profile
 * (same keys as the Python app: ediscovery_browser_user / _password).
 */
export function EdiscoveryAccountCard(): JSX.Element {
  const { t } = useTranslation('ediscoveryAccount')
  const [user, setUser] = useState('')
  const [pw, setPw] = useState('')
  const [configured, setConfigured] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    invoke<{ user: string; configured: boolean }>('ediscovery_creds_status')
      .then((s) => {
        setUser(s.user || '')
        setConfigured(s.configured)
      })
      .catch(() => {})
  }, [])

  async function save(): Promise<void> {
    if (!user.trim() || !pw) {
      setMsg(t('messages.missingInput'))
      return
    }
    setBusy(true)
    try {
      const r = await invoke<{ ok: boolean; error?: string }>('ediscovery_creds_set', {
        user: user.trim(),
        password: pw
      })
      if (r.ok) {
        setConfigured(true)
        setPw('')
        setMsg(t('messages.saved'))
      } else {
        setMsg(t('messages.saveFailed', { error: r.error ?? t('unknownError') }))
      }
    } catch {
      setMsg(t('messages.saveError'))
    } finally {
      setBusy(false)
    }
  }
  async function clear(): Promise<void> {
    setBusy(true)
    try {
      await invoke('ediscovery_creds_clear')
      setConfigured(false)
      setUser('')
      setPw('')
      setMsg(t('messages.cleared'))
    } catch {
      setMsg(t('messages.clearError'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>{t('title')}</h2>
        <span className={`hint stat ${configured ? 'ok' : 'idle'}`}>
          {configured ? t('status.configured') : t('status.notConfigured')}
        </span>
      </div>
      <div className="card-body">
        <p className="muted cap-desc">{t('desc')}</p>
        <div className="ediscovery-form">
          <input
            className="field"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder={t('userPlaceholder')}
            autoComplete="username"
          />
          <input
            className="field"
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder={t('passwordPlaceholder')}
            autoComplete="current-password"
          />
          <button className="btn primary" onClick={save} disabled={busy}>
            {t('save')}
          </button>
          {configured && (
            <button className="btn" onClick={clear} disabled={busy}>
              {t('delete')}
            </button>
          )}
        </div>
        {msg && <span className="muted action-status">{msg}</span>}
      </div>
    </div>
  )
}
