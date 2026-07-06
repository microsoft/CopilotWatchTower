import { Lock, Settings as SettingsIcon } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { capabilityLabel, type CapabilityKey } from '../lib/capabilities'

interface Props {
  required?: CapabilityKey
  onConfigure?: () => void
}

/**
 * Shown in place of a page's content when the tenant's licensing configuration
 * does not include the capability that page needs. Mirrors the Python
 * LockedNotice — the nav item stays clickable; this explains why it is gated
 * and links to the license configuration in Settings.
 */
export function LockedNotice({ required, onConfigure }: Props): JSX.Element {
  const { t } = useTranslation('locked')
  const label = required ? capabilityLabel(required) : t('extraLicense')
  return (
    <div className="content">
      <div className="locked-notice">
        <div className="locked-icon">
          <Lock size={26} />
        </div>
        <h2>{t('title')}</h2>
        <p className="muted">
          <Trans i18nKey="locked:desc" values={{ label }} components={{ strong: <strong /> }} />
        </p>
        {onConfigure && (
          <button className="btn primary locked-cta" onClick={onConfigure} type="button">
            <SettingsIcon size={15} />
            {t('cta')}
          </button>
        )}
        <p className="locked-foot muted">{t('foot')}</p>
      </div>
    </div>
  )
}
