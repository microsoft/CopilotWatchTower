import { Lock, Settings as SettingsIcon } from 'lucide-react'
import { CAPABILITY_LABEL, type CapabilityKey } from '../lib/capabilities'

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
  const label = required ? CAPABILITY_LABEL[required] : '추가 라이선스'
  return (
    <div className="content">
      <div className="locked-notice">
        <div className="locked-icon">
          <Lock size={26} />
        </div>
        <h2>이 기능은 현재 라이선스 구성에서 사용할 수 없습니다</h2>
        <p className="muted">
          <strong>{label}</strong>이(가) 있어야 사용할 수 있는 기능입니다. 테넌트의 라이선스 구성을 설정에서 지정하면
          사용 가능한 기능이 자동으로 조정됩니다.
        </p>
        {onConfigure && (
          <button className="btn primary locked-cta" onClick={onConfigure} type="button">
            <SettingsIcon size={15} />
            설정에서 라이선스 구성하기
          </button>
        )}
        <p className="locked-foot muted">
          eDiscovery 기반 대화 탐색·수집, Teams(Dataverse) 대화, 파워플랫폼 크레딧, 감사 이벤트는 라이선스 구성과 무관하게
          계속 사용할 수 있습니다.
        </p>
      </div>
    </div>
  )
}
