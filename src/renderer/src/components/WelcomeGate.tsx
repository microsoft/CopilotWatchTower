import { Plus, ShieldCheck, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import appIcon from '../assets/app-icon.png'

export function WelcomeGate({ onAdd, loading }: { onAdd: () => void; loading?: boolean }): JSX.Element {
  const { t } = useTranslation('welcome')
  return (
    <div className="welcome-gate">
      <div className="welcome-card">
        <img src={appIcon} className="welcome-logo" alt="" />
        <h1 className="welcome-title">{t('title')}</h1>
        <p className="welcome-desc">{t('desc')}</p>
        <button className="btn primary welcome-btn" onClick={onAdd} disabled={loading}>
          {loading ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
          {t('addStart')}
        </button>
        <div className="welcome-foot">
          <ShieldCheck size={13} /> {t('foot')}
        </div>
      </div>
    </div>
  )
}
