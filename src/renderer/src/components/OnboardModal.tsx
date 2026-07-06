import { useState } from 'react'
import { X, Copy, ExternalLink, Loader2, CheckCircle2, ShieldCheck, AlertCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { invoke, subscribe } from '../lib/api'

interface DeviceCode {
  userCode: string
  verificationUri: string
  message: string
}
interface Progress {
  message: string
  percent: number
}
type Phase = 'idle' | 'running' | 'done' | 'error'

export function OnboardModal({ onClose }: { onClose: () => void }): JSX.Element {
  const { t } = useTranslation('onboarding')
  const [name, setName] = useState('')
  const [edUser, setEdUser] = useState('')
  const [edPassword, setEdPassword] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [dc, setDc] = useState<DeviceCode | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [error, setError] = useState<string | null>(null)

  function friendlyError(code: string | null): string {
    if (code && (['consent-denied', 'consent-access_denied', 'consent-timeout', 'consent-state-mismatch', 'already-running'] as const).includes(code as never)) {
      return t(`errors.${code}`)
    }
    return code || 'unknown'
  }

  async function start(): Promise<void> {
    setPhase('running')
    setError(null)
    setDc(null)
    setProgress({ message: t('running.preparing'), percent: 0 })
    const unsubP = subscribe<Progress>('onboard_progress', setProgress)
    const unsubD = subscribe<DeviceCode>('onboard_device_code', setDc)
    try {
      const res = await invoke<{ ok: boolean; error?: string }>('onboard_start', { name, edUser, edPassword })
      if (res?.ok) {
        setPhase('done')
        setTimeout(() => location.reload(), 1000)
      } else {
        setPhase('error')
        setError(res?.error || 'unknown')
      }
    } catch (e) {
      setPhase('error')
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      unsubP()
      unsubD()
    }
  }

  return (
    <div className="modal-backdrop" onClick={phase === 'running' ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">
            <ShieldCheck size={18} /> {t('modalTitle')}
          </div>
          {phase !== 'running' && (
            <button className="icon-btn" onClick={onClose}>
              <X size={16} />
            </button>
          )}
        </div>

        {phase === 'idle' && (
          <div className="modal-body">
            <p className="muted">{t('idle.intro')}</p>
            <label className="field-label">{t('idle.nameLabel')}</label>
            <input
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('idle.namePlaceholder')}
              autoFocus
            />
            <label className="field-label">{t('idle.edUserLabel')}</label>
            <input
              className="field"
              value={edUser}
              onChange={(e) => setEdUser(e.target.value)}
              placeholder={t('idle.edUserPlaceholder')}
              autoComplete="username"
            />
            <input
              className="field"
              type="password"
              value={edPassword}
              onChange={(e) => setEdPassword(e.target.value)}
              placeholder={t('idle.edPasswordPlaceholder')}
              autoComplete="current-password"
            />
            <p className="muted onb-hint">{t('idle.hint')}</p>
            <button className="btn primary wide" onClick={start}>
              {t('idle.start')}
            </button>
          </div>
        )}

        {phase === 'running' && (
          <div className="modal-body">
            {dc ? (
              <div className="devicecode">
                <div className="muted">{t('running.deviceCodeIntro')}</div>
                <div className="code-box">
                  <span className="code">{dc.userCode}</span>
                  <button
                    className="icon-btn"
                    title={t('running.copy')}
                    onClick={() => navigator.clipboard.writeText(dc.userCode)}
                  >
                    <Copy size={15} />
                  </button>
                </div>
                <a className="btn primary wide" href={dc.verificationUri} target="_blank" rel="noreferrer">
                  {t('running.openLogin')} <ExternalLink size={14} />
                </a>
              </div>
            ) : (
              <div className="modal-loading">
                <Loader2 size={18} className="spin" /> {t('running.preparing')}
              </div>
            )}
            {progress && (
              <div className="onb-progress">
                <div className="onb-bar">
                  <span style={{ width: `${progress.percent}%` }} />
                </div>
                <div className="muted">{progress.message}</div>
              </div>
            )}
          </div>
        )}

        {phase === 'done' && (
          <div className="modal-body center">
            <CheckCircle2 size={42} className="ok-icon" />
            <div className="modal-big">{t('done.title')}</div>
            <div className="muted">{t('done.desc')}</div>
          </div>
        )}

        {phase === 'error' && (
          <div className="modal-body">
            <div className="err-box">
              <AlertCircle size={16} /> {friendlyError(error)}
            </div>
            <button className="btn wide" onClick={() => setPhase('idle')}>
              {t('retry')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
