import { useEffect, useRef, useState } from 'react'
import { MessagesSquare, Users, GitBranch, CloudDownload, Loader2 } from 'lucide-react'
import { Kpi } from '../components/Kpi'
import { LiveLog } from '../components/LiveLog'
import { RawJsonButton } from '../components/RawJsonModal'
import { useCollectionRun, startRun, clearRun } from '../lib/collectRuns'
import { invoke } from '../lib/api'

interface RunRow {
  id: number
  started: string
  trigger: string
  environments: number
  transcripts: number
  rows: number
  errors: number
  status: string
  log: string
}
interface DTO {
  kpis: { interactions: number; users: number; threads: number; apps: number }
  runs: RunRow[]
}

const FALLBACK: DTO = { kpis: { interactions: 0, users: 0, threads: 0, apps: 0 }, runs: [] }

function n(v: number): string {
  return v.toLocaleString('ko-KR')
}

export function TranscriptsCollect(): JSX.Element {
  const [d, setD] = useState<DTO>(FALLBACK)
  const [addAdmin, setAddAdmin] = useState(false)
  const [teamsOnly, setTeamsOnly] = useState(false)
  const run = useCollectionRun('transcripts')

  function load(): void {
    invoke<DTO | null>('dataverse_status')
      .then((x) => {
        if (x) setD(x)
      })
      .catch(() => {})
  }
  useEffect(() => {
    load()
  }, [])

  const prevRunning = useRef(run.running)
  useEffect(() => {
    if (prevRunning.current && !run.running) load()
    prevRunning.current = run.running
  }, [run.running])

  return (
    <div className="content">
      <div className="page-actions">
        <button
          className="btn primary"
          onClick={() => startRun('transcripts', { teamsOnly, addSelfAsAdmin: addAdmin })}
          disabled={run.running}
        >
          {run.running ? <Loader2 size={15} className="spin" /> : <CloudDownload size={15} />} 포털에서 대화 수집
        </button>
        <label className="filter-check">
          <input
            type="checkbox"
            checked={teamsOnly}
            onChange={(e) => setTeamsOnly(e.target.checked)}
            disabled={run.running}
          />
          Teams 채널만 수집 (끄면 웹채·Direct Line 등 모든 채널)
        </label>
        <label className="filter-check">
          <input
            type="checkbox"
            checked={addAdmin}
            onChange={(e) => setAddAdmin(e.target.checked)}
            disabled={run.running}
          />
          접근 권한 없는 환경은 나를 시스템 관리자로 자동 추가
        </label>
      </div>
      <p className="ediscovery-desc">
        설정의 <strong>다운로드 계정</strong>(eDiscovery 서비스 계정)으로 자동 로그인합니다. 계정이 없으면 로그인
        창이 표시됩니다. 기본적으로 <strong>모든 채널</strong>(Teams·웹채·Direct Line 등)의 대화를 수집하며,
        “Teams 채널만” 옵션을 켜면 Teams 대화만 남깁니다. “나를 시스템 관리자로 자동 추가”를 켜면 접근 권한이
        없는 환경에 한해 관리 센터에서 자신을 시스템 관리자로 추가한 뒤 다시 시도합니다.
      </p>

      {(run.running || run.lines.length > 0) && (
        <LiveLog lines={run.lines} running={run.running} percent={run.percent} onClear={() => clearRun('transcripts')} />
      )}

      <div className="kpi-row">
        <Kpi icon={<MessagesSquare />} label="수집 턴" value={n(d.kpis.interactions)} foot="Dataverse 대화" />
        <Kpi icon={<Users />} label="사용자" value={n(d.kpis.users)} foot="distinct" />
        <Kpi icon={<GitBranch />} label="스레드" value={n(d.kpis.threads)} foot="conversation_threads" />
        <Kpi icon={<MessagesSquare />} label="채널" value={n(d.kpis.apps)} foot="apps" />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>수집 실행 이력</h2>
          <span className="hint">최근 {d.runs.length}회</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>시작</th>
              <th>트리거</th>
              <th>환경</th>
              <th>대화</th>
              <th>턴</th>
              <th>상태</th>
              <th>로그</th>
            </tr>
          </thead>
          <tbody>
            {d.runs.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted">
                  아직 수집 실행 이력이 없습니다. 위 버튼으로 수집을 시작하세요.
                </td>
              </tr>
            ) : (
              d.runs.map((r) => (
                <tr key={r.id}>
                  <td className="muted">{r.started}</td>
                  <td className="muted">{r.trigger}</td>
                  <td className="muted">{n(r.environments)}</td>
                  <td className="muted">{n(r.transcripts)}</td>
                  <td>{n(r.rows)}</td>
                  <td>
                    <span className={`stat ${r.status}`}>
                      {r.status === 'ok' ? '완료' : r.status === 'err' ? `오류 ${r.errors}` : '실행 중'}
                    </span>
                  </td>
                  <td>{r.log ? <RawJsonButton data={r.log} title="실행 로그" /> : <span className="muted">—</span>}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
