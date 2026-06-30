import { useEffect, useState } from 'react'
import { invoke } from '../lib/api'

/**
 * eDiscovery ME3 unattended-download service account. ME3 / eDiscovery Standard
 * tenants return a browser-interactive proxy download URL that rejects access
 * tokens, so a service account (no MFA) is needed to auto-fill the sign-in and
 * download with no login prompt. Stored DPAPI-encrypted in the active profile
 * (same keys as the Python app: ediscovery_browser_user / _password).
 */
export function EdiscoveryAccountCard(): JSX.Element {
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
      setMsg('서비스 계정과 비밀번호를 입력하세요.')
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
        setMsg('저장됨 — 다음 ME3 다운로드부터 로그인 창 없이 자동 실행됩니다.')
      } else {
        setMsg(`저장 실패: ${r.error ?? '오류'}`)
      }
    } catch {
      setMsg('저장 중 오류가 발생했습니다.')
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
      setMsg('자격 증명을 삭제했습니다.')
    } catch {
      setMsg('삭제 중 오류가 발생했습니다.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2>eDiscovery 다운로드 계정 (ME3 자동 다운로드)</h2>
        <span className={`hint stat ${configured ? 'ok' : 'idle'}`}>{configured ? '설정됨' : '미설정'}</span>
      </div>
      <div className="card-body">
        <p className="muted cap-desc">
          eDiscovery Standard(ME3) 테넌트의 내보내기 다운로드는 브라우저 로그인이 필요합니다. MFA가 없는 전용 서비스 계정을
          등록하면 로그인 창 없이 자동으로 다운로드합니다. (MFA 계정은 자동 입력 후 창에서 직접 승인해야 합니다.) 비밀번호는
          Windows DPAPI로 암호화되어 이 PC의 프로필에만 저장됩니다.
        </p>
        <div className="ediscovery-form">
          <input
            className="field"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="서비스 계정 (user@tenant)"
            autoComplete="username"
          />
          <input
            className="field"
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="비밀번호"
            autoComplete="current-password"
          />
          <button className="btn primary" onClick={save} disabled={busy}>
            저장
          </button>
          {configured && (
            <button className="btn" onClick={clear} disabled={busy}>
              삭제
            </button>
          )}
        </div>
        {msg && <span className="muted action-status">{msg}</span>}
      </div>
    </div>
  )
}
