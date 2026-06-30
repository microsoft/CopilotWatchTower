import { Construction } from 'lucide-react'

/**
 * Shared "not wired yet" page. The sidebar/route structure mirrors the original
 * app (24 menu items); pages that aren't implemented yet render this so every
 * menu still navigates to a real screen.
 */
export function Stub(): JSX.Element {
  return (
    <div className="content">
      <div className="card">
        <div className="card-body">
          <div className="empty">
            <div className="empty-icon">
              <Construction size={24} />
            </div>
            <div className="empty-title">준비 중인 화면입니다</div>
            <div className="empty-desc">
              메뉴 구조는 원본 앱과 동일하게 맞춰 두었습니다. 이 화면의 실제 데이터와 기능은 다음 단계에서 구현됩니다.
            </div>
            <div className="empty-tag">준비 중</div>
          </div>
        </div>
      </div>
    </div>
  )
}
