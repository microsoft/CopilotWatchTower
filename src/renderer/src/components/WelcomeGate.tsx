import { Plus, ShieldCheck, Loader2 } from 'lucide-react'
import appIcon from '../assets/app-icon.png'

export function WelcomeGate({ onAdd, loading }: { onAdd: () => void; loading?: boolean }): JSX.Element {
  return (
    <div className="welcome-gate">
      <div className="welcome-card">
        <img src={appIcon} className="welcome-logo" alt="" />
        <h1 className="welcome-title">CopilotWatchTower</h1>
        <p className="welcome-desc">
          Microsoft 365 Copilot 사용 현황을 수집·분석하려면 먼저 테넌트 프로필을 추가하세요. 관리자 디바이스 코드
          로그인으로 앱 등록과 권한 동의가 자동으로 처리됩니다.
        </p>
        <button className="btn primary welcome-btn" onClick={onAdd} disabled={loading}>
          {loading ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
          프로필 추가하고 시작하기
        </button>
        <div className="welcome-foot">
          <ShieldCheck size={13} /> 자격 증명은 Windows DPAPI로 이 PC에만 암호화되어 저장됩니다.
        </div>
      </div>
    </div>
  )
}
