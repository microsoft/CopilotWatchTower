import { Construction } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * Shared "not wired yet" page. The sidebar/route structure mirrors the original
 * app (24 menu items); pages that aren't implemented yet render this so every
 * menu still navigates to a real screen.
 */
export function Stub(): JSX.Element {
  const { t } = useTranslation('stub')
  return (
    <div className="content">
      <div className="card">
        <div className="card-body">
          <div className="empty">
            <div className="empty-icon">
              <Construction size={24} />
            </div>
            <div className="empty-title">{t('title')}</div>
            <div className="empty-desc">{t('desc')}</div>
            <div className="empty-tag">{t('tag')}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
