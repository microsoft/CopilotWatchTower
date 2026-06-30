import { useState } from 'react'
import { X, Copy, ExternalLink, Loader2, CheckCircle2, ShieldCheck, AlertCircle } from 'lucide-react'
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

function friendlyError(code: string | null): string {
  switch (code) {
    case 'consent-denied':
      return '관리자 동의가 거부되었거나 앤 등록 전파가 아직 끝나지 않았을 수 있습니다. 잠시 후 “다시 시도”를 눌러 주세요. 동의 화면에서는 반드시 “수락/동의”를 눌러야 하며, 전역 관리자 계정이어야 합니다.'
    case 'consent-access_denied':
      return '관리자 동의가 거부되었습니다. 전역 관리자 계정으로 동의 화면에서 “수락”을 눌러 주세요.'
    case 'consent-timeout':
      return '동의 대기 시간(5분)이 초과되었습니다. 다시 시도해 주세요.'
    case 'consent-state-mismatch':
      return '보안 검증(state)에 실패했습니다. 다시 시도해 주세요.'
    case 'already-running':
      return '온보딩이 이미 진행 중입니다.'
    default:
      return code || 'unknown'
  }
}

export function OnboardModal({ onClose }: { onClose: () => void }): JSX.Element {
  const [name, setName] = useState('')
  const [edUser, setEdUser] = useState('')
  const [edPassword, setEdPassword] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [dc, setDc] = useState<DeviceCode | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function start(): Promise<void> {
    setPhase('running')
    setError(null)
    setDc(null)
    setProgress({ message: '시작 중…', percent: 0 })
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
            <ShieldCheck size={18} /> 새 프로필 · 테넌트 온보딩
          </div>
          {phase !== 'running' && (
            <button className="icon-btn" onClick={onClose}>
              <X size={16} />
            </button>
          )}
        </div>

        {phase === 'idle' && (
          <div className="modal-body">
            <p className="muted">
              관리자 계정으로 로그인하면 이 테넌트에 수집용 Entra 앱이 자동 등록되고 관리자 동의가 진행됩니다.
            </p>
            <label className="field-label">프로필 이름 (선택)</label>
            <input
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: contoso"
              autoFocus
            />
            <label className="field-label">eDiscovery 다운로드 계정 (선택 · ME3 자동 다운로드)</label>
            <input
              className="field"
              value={edUser}
              onChange={(e) => setEdUser(e.target.value)}
              placeholder="서비스 계정 (user@tenant)"
              autoComplete="username"
            />
            <input
              className="field"
              type="password"
              value={edPassword}
              onChange={(e) => setEdPassword(e.target.value)}
              placeholder="비밀번호 (MFA 없는 계정)"
              autoComplete="current-password"
            />
            <p className="muted onb-hint">
              ME3 테넌트는 eDiscovery 내보내기 다운로드에 브라우저 로그인이 필요합니다. 등록하면 로그인 창 없이 자동
              다운로드합니다. 나중에 설정에서도 추가할 수 있습니다.
            </p>
            <button className="btn primary wide" onClick={start}>
              온보딩 시작
            </button>
          </div>
        )}

        {phase === 'running' && (
          <div className="modal-body">
            {dc ? (
              <div className="devicecode">
                <div className="muted">아래 코드를 입력해 관리자 로그인 후, 권한 동의까지 완료하세요.</div>
                <div className="code-box">
                  <span className="code">{dc.userCode}</span>
                  <button
                    className="icon-btn"
                    title="복사"
                    onClick={() => navigator.clipboard.writeText(dc.userCode)}
                  >
                    <Copy size={15} />
                  </button>
                </div>
                <a className="btn primary wide" href={dc.verificationUri} target="_blank" rel="noreferrer">
                  로그인 페이지 열기 <ExternalLink size={14} />
                </a>
              </div>
            ) : (
              <div className="modal-loading">
                <Loader2 size={18} className="spin" /> 로그인 준비 중…
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
            <div className="modal-big">온보딩 완료</div>
            <div className="muted">새 프로필로 전환합니다…</div>
          </div>
        )}

        {phase === 'error' && (
          <div className="modal-body">
            <div className="err-box">
              <AlertCircle size={16} /> {friendlyError(error)}
            </div>
            <button className="btn wide" onClick={() => setPhase('idle')}>
              다시 시도
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
