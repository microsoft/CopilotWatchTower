import { useEffect, useState } from 'react'
import { FileSearch, Download, Inbox, RefreshCw, Play, Square, Trash2 } from 'lucide-react'
import { Kpi } from '../components/Kpi'
import { LiveLog } from '../components/LiveLog'
import { RawJsonButton } from '../components/RawJsonModal'
import {
  useEdiscoveryRun,
  edBeginRun,
  edLog,
  edEndRun,
  edClearRun,
  getEdiscoveryRun
} from '../lib/collectRuns'
import { invoke, subscribe } from '../lib/api'

interface JobRow {
  id: string
  target: string
  status: string
  window: string
  added: number
  updated: string
  error: string | null
  running: boolean
  raw?: Record<string, unknown>
}
interface EdiscoveryData {
  kpis: { jobs: number; items: number; running: number; failed: number }
  jobs: JobRow[]
}

const STAGE_LABEL: Record<string, string> = {
  pending: '대기',
  preflight: '권한 확인',
  case: '케이스 생성',
  searching: '검색',
  exporting: '내보내기',
  downloading: '다운로드',
  parsing: '파싱',
  done: '완료',
  error: '오류'
}
function stageClass(s: string): string {
  if (s === 'done') return 'ok'
  if (s === 'error') return 'err'
  return 'run'
}
const n = (v: number): string => v.toLocaleString('ko-KR')
function startErr(e?: string): string {
  if (e === 'no-tenant') return '테넌트 정보가 없습니다. 먼저 온보딩하세요.'
  if (e === 'no-upn') return '대상 사용자 UPN을 입력하세요.'
  if (e === 'already-running') return '이미 수집이 실행 중입니다.'
  return e ?? 'unknown'
}

export function Ediscovery(): JSX.Element {
  const [data, setData] = useState<EdiscoveryData | null>(null)
  const [upn, setUpn] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const run = useEdiscoveryRun()
  const running = run.running
  const lines = run.lines

  // ME3 unattended-download service account (DPAPI-stored in the profile).
  const [credUser, setCredUser] = useState('')
  const [credPw, setCredPw] = useState('')
  const [credConfigured, setCredConfigured] = useState(false)
  const [credBusy, setCredBusy] = useState(false)
  const [credMsg, setCredMsg] = useState<string | null>(null)

  function load(): void {
    invoke<EdiscoveryData | null>('ediscovery_overview')
      .then((d) => {
        if (d) setData(d)
      })
      .catch(() => {})
  }
  useEffect(() => {
    load()
    invoke<{ user: string; configured: boolean }>('ediscovery_creds_status')
      .then((s) => {
        setCredUser(s.user || '')
        setCredConfigured(s.configured)
      })
      .catch(() => {})
  }, [])

  async function startCollection(jobId?: string): Promise<void> {
    if (getEdiscoveryRun().running) return
    if (!jobId && !upn.trim()) return
    edBeginRun(!jobId)
    edLog(jobId ? '수집 재개…' : `수집 시작: ${upn.trim()}`)
    const unsub = subscribe<{ stage?: string; message?: string }>('ediscovery_progress', (p) => {
      edLog(p.message ?? '', p.stage === 'error' ? 'error' : p.stage === 'done' ? 'success' : undefined)
    })
    try {
      const r = await invoke<{ ok: boolean; error?: string; added?: number }>(
        'ediscovery_collect_start',
        jobId ? { jobId } : { upn: upn.trim(), start: start || undefined, end: end || undefined }
      )
      if (r.ok) edLog(`완료 · ${r.added ?? 0}개 상호작용`, 'success')
      else edLog(`오류: ${startErr(r.error)}`, 'error')
    } catch (e) {
      edLog(`오류: ${e instanceof Error ? e.message : String(e)}`, 'error')
    } finally {
      unsub()
      edEndRun()
      load()
    }
  }

  async function stopCollection(): Promise<void> {
    await invoke('ediscovery_collect_stop').catch(() => {})
    edLog('중단 요청됨…', 'warn')
  }

  async function deleteJob(id: string): Promise<void> {
    if (running) return
    try {
      const r = await invoke<{
        ok: boolean
        error?: string
        canceled?: boolean
        deletedConversations?: boolean
        removed?: { interactions: number; threads: number }
      }>('ediscovery_job_delete', id)
      if (r.canceled) return
      if (r.ok) {
        if (r.deletedConversations && r.removed) {
          edLog(`작업과 대화 삭제됨 (대화 ${r.removed.interactions}건·스레드 ${r.removed.threads}개)`, 'success')
        } else {
          edLog('작업 기록만 삭제됨', 'success')
        }
        load()
      } else {
        edLog(`작업 삭제 실패: ${r.error === 'collecting' ? '수집 중에는 삭제할 수 없습니다.' : (r.error ?? '오류')}`, 'error')
      }
    } catch (e) {
      edLog(`작업 삭제 오류: ${e instanceof Error ? e.message : String(e)}`, 'error')
    }
  }

  async function saveCreds(): Promise<void> {
    if (!credUser.trim() || !credPw) {
      setCredMsg('계정과 비밀번호를 입력하세요.')
      return
    }
    setCredBusy(true)
    try {
      const r = await invoke<{ ok: boolean; error?: string }>('ediscovery_creds_set', {
        user: credUser.trim(),
        password: credPw
      })
      if (r.ok) {
        setCredConfigured(true)
        setCredPw('')
        setCredMsg('저장됨 — 다음 ME3 다운로드부터 로그인 창 없이 자동 실행됩니다.')
      } else {
        setCredMsg(`저장 실패: ${r.error ?? '오류'}`)
      }
    } catch {
      setCredMsg('저장 중 오류가 발생했습니다.')
    } finally {
      setCredBusy(false)
    }
  }
  async function clearCreds(): Promise<void> {
    setCredBusy(true)
    try {
      await invoke('ediscovery_creds_clear')
      setCredConfigured(false)
      setCredUser('')
      setCredPw('')
      setCredMsg('자격 증명을 삭제했습니다.')
    } catch {
      setCredMsg('삭제 중 오류가 발생했습니다.')
    } finally {
      setCredBusy(false)
    }
  }

  const k = data?.kpis
  const jobs = data?.jobs ?? []

  return (
    <div className="content">
      <div className="card">
        <div className="card-head">
          <h2>새 수집 시작</h2>
          <span className="hint">Purview eDiscovery · 온보딩 로그인 자동 재사용</span>
        </div>
        <div className="card-body">
          <p className="muted ediscovery-desc">
            대상 사용자(UPN)와 선택적 기간을 지정해 Copilot 프롬프트/응답을 Microsoft Purview eDiscovery로 수집합니다. 온보딩
            로그인을 자동 재사용하므로 추가 로그인 없이 실행되며(예외 시에만 디바이스 코드 안내), 중단·실패한 작업은 아래
            이력에서 재개할 수 있습니다.
          </p>
          <div className="ediscovery-form">
            <input
              className="field"
              value={upn}
              onChange={(e) => setUpn(e.target.value)}
              placeholder="대상 사용자 UPN (user@tenant)"
            />
            <input
              type="date"
              className="field"
              value={start}
              max={end || undefined}
              onChange={(e) => setStart(e.target.value)}
              title="시작일(선택)"
            />
            <span className="filter-dash">~</span>
            <input
              type="date"
              className="field"
              value={end}
              min={start || undefined}
              onChange={(e) => setEnd(e.target.value)}
              title="종료일(선택)"
            />
            {running ? (
              <button className="btn" onClick={stopCollection}>
                <Square size={14} /> 중단
              </button>
            ) : (
              <button className="btn primary" onClick={() => startCollection()} disabled={!upn.trim()}>
                <Play size={15} /> 수집 시작
              </button>
            )}
          </div>
        </div>
      </div>

      {(running || lines.length > 0) && (
        <>
          <div className="section-gap" />
          <LiveLog lines={lines} running={running} onClear={() => edClearRun()} />
        </>
      )}

      <div className="section-gap" />

      <div className="kpi-row">
        <Kpi icon={<Download />} label="작업" value={k ? n(k.jobs) : '0'} foot="누적 수집 작업" />
        <Kpi icon={<RefreshCw />} label="진행 중" value={k ? n(k.running) : '0'} foot="수집 실행 중" />
        <Kpi icon={<Inbox />} label="가져온 항목" value={k ? n(k.items) : '0'} foot="대화" />
        <Kpi icon={<FileSearch />} label="실패" value={k ? n(k.failed) : '0'} foot="재시도 가능" />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>수집 작업 이력</h2>
          <span className="hint">{n(jobs.length)}건</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>대상</th>
              <th>상태</th>
              <th>기간</th>
              <th>추가</th>
              <th>갱신</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  아직 수집 작업이 없습니다. 위에서 새 수집을 시작하세요.
                </td>
              </tr>
            ) : (
              jobs.map((j) => (
                <tr key={j.id}>
                  <td className="ttl">{j.target}</td>
                  <td title={j.error ?? undefined}>
                    <span className={`stat ${stageClass(j.status)}`}>{STAGE_LABEL[j.status] || j.status}</span>
                  </td>
                  <td className="muted">{j.window}</td>
                  <td className="muted">{n(j.added)}</td>
                  <td className="muted">{j.updated}</td>
                  <td className="right">
                    <div className="row-actions">
                      {j.status !== 'done' && (
                        <button className="btn-sm" disabled={running} onClick={() => startCollection(j.id)}>
                          재개
                        </button>
                      )}
                      <RawJsonButton data={j.raw ?? j} title={`작업 원본 · ${j.target}`} />
                      <button
                        className="btn-sm danger"
                        disabled={running}
                        title="작업 기록 삭제"
                        onClick={() => deleteJob(j.id)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="section-gap" />

      <div className="card">
        <div className="card-head">
          <h2>다운로드 계정 (ME3 자동 다운로드)</h2>
          <span className={`hint stat ${credConfigured ? 'ok' : 'idle'}`}>{credConfigured ? '설정됨' : '미설정'}</span>
        </div>
        <div className="card-body">
          <p className="muted ediscovery-desc">
            eDiscovery Standard(ME3) 테넌트는 내보내기 다운로드에 브라우저 로그인이 필요합니다. MFA가 없는 전용 서비스
            계정을 등록하면 로그인 창 없이 자동으로 다운로드합니다. (MFA 계정은 자동 입력 후 창에서 직접 승인해야 합니다.) 비밀번호는
            Windows DPAPI로 암호화되어 이 PC의 프로필에만 저장됩니다.
          </p>
          <div className="ediscovery-form">
            <input
              className="field"
              value={credUser}
              onChange={(e) => setCredUser(e.target.value)}
              placeholder="서비스 계정 (user@tenant)"
              autoComplete="username"
            />
            <input
              className="field"
              type="password"
              value={credPw}
              onChange={(e) => setCredPw(e.target.value)}
              placeholder="비밀번호"
              autoComplete="current-password"
            />
            <button className="btn primary" onClick={saveCreds} disabled={credBusy}>
              저장
            </button>
            {credConfigured && (
              <button className="btn" onClick={clearCreds} disabled={credBusy}>
                삭제
              </button>
            )}
          </div>
          {credMsg && <span className="muted action-status">{credMsg}</span>}
        </div>
      </div>
    </div>
  )
}
