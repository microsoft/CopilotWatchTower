/**
 * Portal sign-in token capture — the portable replacement for the Python
 * app's Playwright headless flow. Opens a real Electron BrowserWindow (which
 * IS Chromium), lets the admin sign in interactively, and sniffs the
 * `Authorization: Bearer` header off the first request the SPA makes to the
 * target API host. No password storage, no bundled browser.
 */
import { BrowserWindow, session, type DownloadItem, type Event as ElectronEvent } from 'electron'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { httpRequest } from './http'
import { hardenPortalWindow } from './windowSecurity'

export interface CaptureOptions {
  /** URL to load (e.g. the PPAC capacity page). */
  loadUrl: string
  /** API host whose outgoing bearer token we want (e.g. licensing.powerplatform.microsoft.com). */
  matchHost: string
  /** Window title shown to the admin. */
  title: string
  /** Persisted partition so the admin does not re-sign-in every cycle. */
  partition?: string
  /** Overall timeout before giving up (default 5 min). */
  timeoutMs?: number
  /** Stored service-account credentials for unattended auto-login (hidden window). */
  credentials?: { user: string; password: string }
  onLog?: (line: string) => void
}

/** Open a sign-in window and resolve with the captured bearer token. */
export function captureBearerToken(opts: CaptureOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const partition = opts.partition ?? 'persist:portal'
    const ses = session.fromPartition(partition)
    const filter = { urls: [`*://${opts.matchHost}/*`] }
    const creds = opts.credentials
    let settled = false
    let shown = false
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let lastStep = ''
    let stalls = 0

    const win = new BrowserWindow({
      width: 1120,
      height: 860,
      title: opts.title,
      show: !creds, // hidden + unattended when credentials can auto-login
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    })
    hardenPortalWindow(win, opts.onLog)

    function reveal(reason: string): void {
      if (shown || settled || win.isDestroyed()) return
      shown = true
      opts.onLog?.(`로그인 창을 표시합니다 (${reason}).`)
      win.show()
    }
    if (!creds) reveal('다운로드 계정 미등록 — 직접 로그인하세요')

    function cleanup(): void {
      try {
        ses.webRequest.onBeforeSendHeaders(filter, null)
      } catch {
        /* ignore */
      }
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }

    function finish(err: Error | null, token?: string): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      if (!win.isDestroyed()) {
        // Let the in-flight request complete before closing the window.
        setTimeout(() => {
          if (!win.isDestroyed()) win.close()
        }, 400)
      }
      if (err) reject(err)
      else resolve(token as string)
    }

    ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      const headers = details.requestHeaders
      const authKey = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization')
      const auth = authKey ? String(headers[authKey] ?? '') : ''
      if (!settled && auth.toLowerCase().startsWith('bearer ')) {
        const token = auth.slice(7).trim()
        if (token) {
          opts.onLog?.('인증 토큰을 캡처했습니다.')
          callback({ requestHeaders: headers })
          finish(null, token)
          return
        }
      }
      callback({ requestHeaders: headers })
    })

    async function execLogin(doClick: boolean): Promise<string> {
      if (!creds || win.isDestroyed()) return ''
      try {
        const r = await win.webContents.executeJavaScript(loginScript(creds.user, creds.password, doClick), true)
        return typeof r === 'string' ? r : 'none'
      } catch {
        return ''
      }
    }

    async function tick(): Promise<void> {
      if (settled || win.isDestroyed()) return
      let host = ''
      try {
        host = new URL(win.webContents.getURL()).host.toLowerCase()
      } catch {
        return
      }
      const isLogin =
        host.includes('login.microsoftonline.com') ||
        host.includes('login.microsoft.com') ||
        host.includes('login.live.com')
      if (!isLogin) return
      if (!creds) {
        reveal('로그인 필요')
        return
      }
      const step = await execLogin(false)
      if (step && step !== lastStep) {
        lastStep = step
        stalls = 0
        if (step !== 'none' && !step.startsWith('err')) {
          opts.onLog?.(`자동 로그인: ${step}`)
          await execLogin(true)
        }
        return
      }
      stalls += 1
      if (stalls === 4) await execLogin(true)
      if (stalls >= 13) reveal('자동 로그인이 진행되지 않습니다(MFA·계정/비밀번호 오류 가능)')
    }

    const startPoll = (): void => {
      if (!pollTimer && !settled) pollTimer = setInterval(() => void tick(), 1500)
    }
    win.webContents.on('did-finish-load', startPoll)
    win.webContents.on('did-stop-loading', startPoll)
    win.webContents.on('did-navigate', startPoll)

    const timer = setTimeout(
      () => finish(new Error('시간 초과: 토큰을 캡처하지 못했습니다.')),
      opts.timeoutMs ?? 300_000
    )

    win.on('closed', () => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        cleanup()
        reject(new Error('로그인 창이 닫혔습니다 (취소됨).'))
      }
    })

    opts.onLog?.(creds ? '자동 로그인으로 소비 토큰을 수집합니다…' : '포털 로그인 창을 여는 중…')
    // Auth redirects ABORT the initial navigation (ERR_ABORTED) — normal, not fatal;
    // the poll loop drives login + capture.
    setTimeout(startPoll, 3000)
    win.loadURL(opts.loadUrl).catch((e) => {
      opts.onLog?.(`초기 페이지 이동 리디렉션(정상일 수 있음): ${e instanceof Error ? e.message : String(e)}`)
    })
  })
}

// ---- interactive file download (eDiscovery ME3 proxy / IsDirectDownloadProxy) --

export interface BrowserDownloadOptions {
  /** Window title shown to the admin. */
  title?: string
  /** Persisted partition so the admin does not re-sign-in every download. */
  partition?: string
  /** Overall timeout before giving up (default 5 min). */
  timeoutMs?: number
  onLog?: (line: string) => void
  /**
   * Service-account credentials for *unattended* auto-login (the Python
   * headless-Playwright equivalent). When present the login form is filled
   * automatically in a hidden window — zero login prompts. Only works for an
   * account WITHOUT MFA / Conditional Access; otherwise the window is revealed
   * so the admin can complete the challenge.
   */
  credentials?: { user: string; password: string }
}

/** Auto-fill script for the Microsoft sign-in flow (email → password → KMSI). */
function loginScript(user: string, password: string, doClick: boolean): string {
  const u = JSON.stringify(user)
  const p = JSON.stringify(password)
  const DO = doClick ? 'true' : 'false'
  return `(() => {
    try {
      const DO = ${DO};
      // MS sign-in is React-controlled: assigning .value directly is ignored.
      // Use the native value setter so React registers the change, else 'Next'
      // sees an empty field and never advances.
      const setVal = (el, val) => {
        const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
        if (d && d.set) d.set.call(el, val); else el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const vis = (el) => el && el.offsetParent !== null && !el.disabled;
      const submit = document.querySelector('#idSIButton9, input[type=submit], button[type=submit]');
      const pwd = document.querySelector('input[name=passwd], input[type=password]');
      const email = document.querySelector('input[name=loginfmt], input[type=email]');
      if (vis(pwd)) {
        if (pwd.value !== ${p}) setVal(pwd, ${p});
        if (DO && vis(submit)) submit.click();
        return 'password';
      }
      if (vis(email)) {
        if (email.value !== ${u}) setVal(email, ${u});
        if (DO && vis(submit)) submit.click();
        return 'email';
      }
      const yes = document.querySelector('#idSIButton9');
      if (vis(yes)) { if (DO) yes.click(); return 'kmsi'; }
      return 'none';
    } catch (e) { return 'err:' + (e && e.message); }
  })()`
}

/**
 * Download a file through an Electron BrowserWindow — the portable replacement
 * for the Python headless-Playwright eDiscovery download. ME3 / eDiscovery
 * Standard tenants return a browser-interactive proxy URL
 * (``proxyservice.ediscovery`` / ``IsDirectDownloadProxy``) that rejects access
 * tokens and needs an interactive id_token session.
 *
 * Runs UNATTENDED when ``credentials`` are supplied: a hidden window auto-fills
 * the Microsoft sign-in (no login prompt). If no credentials are set, or the
 * auto-login stalls (MFA / DOM change), the window is revealed so the admin can
 * finish manually. A persisted partition means later downloads reuse the
 * session and stay silent.
 */
export function downloadViaBrowser(
  url: string,
  opts: BrowserDownloadOptions = {}
): Promise<{ buffer: Buffer; filename: string }> {
  return new Promise((resolve, reject) => {
    const partition = opts.partition ?? 'persist:ediscovery'
    const ses = session.fromPartition(partition)
    const tmpPath = join(tmpdir(), `cwt-ediscovery-${randomUUID()}.zip`)
    const creds = opts.credentials
    let settled = false
    let shown = false
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let lastStep = ''
    let stalls = 0

    const win = new BrowserWindow({
      width: 1120,
      height: 860,
      title: opts.title ?? 'eDiscovery 다운로드',
      show: false, // hidden: unattended when credentials succeed
      autoHideMenuBar: true,
      webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true }
    })
    hardenPortalWindow(win, opts.onLog)

    function reveal(reason: string): void {
      if (shown || settled || win.isDestroyed()) return
      shown = true
      opts.onLog?.(`자동 로그인을 완료할 수 없어 로그인 창을 표시합니다 (${reason}). 직접 로그인하세요. (15분 대기)`)
      win.show()
      win.focus()
      // give the operator time to sign in manually instead of failing now
      clearTimeout(timer)
      timer = setTimeout(() => finish(new Error('시간 초과: 다운로드를 완료하지 못했습니다.')), 900_000)
    }

    const onWillDownload = (_e: ElectronEvent, item: DownloadItem): void => {
      const filename = item.getFilename() || 'ediscovery-export.zip'
      opts.onLog?.(`다운로드 시작: ${filename}`)
      item.setSavePath(tmpPath)
      item.once('done', (_ev, state) => {
        if (state === 'completed') {
          try {
            finish(null, { buffer: readFileSync(tmpPath), filename })
          } catch (e) {
            finish(e instanceof Error ? e : new Error(String(e)))
          }
        } else {
          finish(new Error(`다운로드 실패: ${state}`))
        }
      })
    }

    async function execLogin(doClick: boolean): Promise<string> {
      if (!creds) return ''
      try {
        const r = await win.webContents.executeJavaScript(loginScript(creds.user, creds.password, doClick), true)
        return typeof r === 'string' ? r : 'none'
      } catch {
        return '' // page is navigating — retry on the next tick
      }
    }
    async function handleLogin(): Promise<void> {
      if (settled || shown || win.isDestroyed()) return
      let host = ''
      try {
        host = new URL(win.webContents.getURL()).host.toLowerCase()
      } catch {
        return
      }
      const isLogin =
        host.includes('login.microsoftonline.com') ||
        host.includes('login.microsoft.com') ||
        host.includes('login.live.com')
      if (!isLogin) {
        // On the proxy/blob page (or already signed in) — just await the download.
        lastStep = ''
        stalls = 0
        return
      }
      if (!creds) {
        reveal('다운로드 계정 미등록 — eDiscovery 페이지/설정에 서비스 계정을 등록하면 자동 로그인됩니다')
        return
      }
      // Detect the current sign-in step (fills empty fields, no click yet).
      const step = await execLogin(false)
      if (step && step !== lastStep) {
        lastStep = step
        stalls = 0
        if (step !== 'none' && !step.startsWith('err')) {
          opts.onLog?.(`자동 로그인: ${step}`)
          await execLogin(true) // act on this new step: fill + click
        }
        return
      }
      // Same step as last poll — not progressing.
      stalls += 1
      if (stalls === 4) await execLogin(true) // mid-way retry click
      if (stalls >= 13) reveal('자동 로그인이 진행되지 않습니다(MFA·계정/비밀번호 오류 가능)')
    }

    const startPoll = (): void => {
      if (!pollTimer) pollTimer = setInterval(() => void handleLogin(), 1500)
    }
    // Auth redirects ABORT the initial nav (no did-finish-load) — start polling on
    // ANY navigation/settle event + a safety timer so auto-login always runs.
    win.webContents.on('did-finish-load', startPoll)
    win.webContents.on('did-stop-loading', startPoll)
    win.webContents.on('did-navigate', startPoll)
    setTimeout(startPoll, 3000)

    function finish(err: Error | null, result?: { buffer: Buffer; filename: string }): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (pollTimer) clearInterval(pollTimer)
      try {
        ses.removeListener('will-download', onWillDownload)
      } catch {
        /* ignore */
      }
      try {
        rmSync(tmpPath, { force: true })
      } catch {
        /* ignore */
      }
      if (!win.isDestroyed()) setTimeout(() => !win.isDestroyed() && win.close(), 300)
      if (err) reject(err)
      else resolve(result as { buffer: Buffer; filename: string })
    }

    ses.on('will-download', onWillDownload)
    let timer = setTimeout(() => reveal('시간 초과'), opts.timeoutMs ?? 300_000)
    win.on('closed', () => {
      if (!settled) finish(new Error('취소됨: 다운로드 창이 닫혔습니다.'))
    })

    opts.onLog?.(creds ? '자동 로그인으로 다운로드를 시도합니다…' : '다운로드 창에서 로그인이 필요할 수 있습니다…')
    // auth redirects abort the initial nav (ERR_ABORTED) — log, don't fail.
    win.loadURL(url).catch((e) => opts.onLog?.(`이동 중: ${e instanceof Error ? e.message : String(e)}`))
  })
}

// ---- multi-host token capture (Dataverse: per-environment tokens) -------

export type PortalTokens = Record<string, string>

function mergeLocalStorageTokens(tokens: PortalTokens, entries: Array<[string, string]>): void {
  for (const [key, value] of entries) {
    if (!value) continue
    const hay = `${key} ${value}`.toLowerCase()
    if (!hay.includes('.dynamics.com')) continue
    let blob: Record<string, unknown>
    try {
      blob = JSON.parse(value)
    } catch {
      continue
    }
    if (!blob || typeof blob !== 'object') continue
    const secret = blob.secret || blob.accessToken || blob.access_token
    if (typeof secret !== 'string' || !secret.trim()) continue
    let target = ''
    for (const f of ['target', 'realm', 'scopes']) {
      const c = blob[f]
      if (typeof c === 'string' && c.toLowerCase().includes('.dynamics.com')) {
        target = c
        break
      }
    }
    let host = ''
    for (const part of target.replace(/,/g, ' ').split(/\s+/)) {
      try {
        const h = new URL(part).host.toLowerCase()
        if (h.includes('.dynamics.com')) {
          host = h
          break
        }
      } catch {
        /* not a url */
      }
    }
    if (!host) {
      for (const part of key.split(/[-\s]/)) {
        if (part.toLowerCase().includes('.dynamics.com')) {
          host = part.toLowerCase()
          break
        }
      }
    }
    if (!host || tokens[host]) continue
    tokens[host] = secret.trim()
  }
}

/**
 * Open a portal sign-in window and capture EVERY bearer token (keyed by host)
 * the SPA sends to hosts matching `matchHostFragment` (e.g. `.dynamics.com`),
 * plus any in the MSAL localStorage cache. Resolves when the admin closes the
 * window. Used for Dataverse where each environment has its own token audience.
 */
export function capturePortalTokens(opts: {
  loadUrl: string
  matchHostFragment: string
  title: string
  partition?: string
  onLog?: (line: string) => void
}): Promise<PortalTokens> {
  return new Promise((resolve, reject) => {
    const partition = opts.partition ?? 'persist:portal'
    const ses = session.fromPartition(partition)
    const filter = { urls: [`*://*${opts.matchHostFragment}/*`] }
    const tokens: PortalTokens = {}
    let finishing = false

    const win = new BrowserWindow({
      width: 1180,
      height: 880,
      title: opts.title,
      autoHideMenuBar: true,
      webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true }
    })
    hardenPortalWindow(win, opts.onLog)

    ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      const headers = details.requestHeaders
      const authKey = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization')
      const auth = authKey ? String(headers[authKey] ?? '') : ''
      if (auth.toLowerCase().startsWith('bearer ')) {
        let host = ''
        try {
          host = new URL(details.url).host.toLowerCase()
        } catch {
          host = ''
        }
        const token = auth.slice(7).trim()
        if (host && token && !tokens[host]) {
          tokens[host] = token
          opts.onLog?.(`토큰 캡처: ${host}`)
        }
      }
      callback({ requestHeaders: headers })
    })

    function cleanup(): void {
      try {
        ses.webRequest.onBeforeSendHeaders(filter, null)
      } catch {
        /* ignore */
      }
    }

    // On close, scan the MSAL localStorage cache for silently-acquired per-org
    // tokens before the webContents is torn down.
    win.on('close', (e) => {
      if (finishing || win.isDestroyed()) return
      e.preventDefault()
      finishing = true
      opts.onLog?.('토큰 캐시를 확인하는 중…')
      win.webContents
        .executeJavaScript('JSON.stringify(Object.entries(localStorage))')
        .then((json: string) => {
          try {
            mergeLocalStorageTokens(tokens, JSON.parse(json))
          } catch {
            /* ignore */
          }
        })
        .catch(() => {})
        .finally(() => {
          cleanup()
          if (!win.isDestroyed()) win.destroy()
        })
    })

    win.on('closed', () => {
      cleanup()
      if (Object.keys(tokens).length === 0) {
        reject(new Error('토큰을 캡처하지 못했습니다 (로그인 취소 또는 환경 미방문).'))
      } else {
        resolve(tokens)
      }
    })

    opts.onLog?.('포털 로그인 후, 수집할 환경을 열어주세요. 끝나면 창을 닫으세요.')
    win.loadURL(opts.loadUrl).catch((err) => {
      if (!win.isDestroyed()) win.destroy()
      reject(err instanceof Error ? err : new Error(String(err)))
    })
  })
}

// ---- Dataverse: unattended auto-login + per-env token mint + self-add-admin --
// Port of the Python dataverse_browser_download flow: sign in with the stored
// service account, enumerate environments via the BAP API, navigate the maker
// SPA to each environment so MSAL silently mints its org-audience Dataverse
// token, and — when opted in — add the signed-in user as a System Administrator
// to environments they cannot otherwise reach (the admin-center "나 추가" button).

const POWERAPPS_MAKER_ENVS_URL = 'https://make.powerapps.com/environments'
const BAP_ENVIRONMENTS_URL =
  'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments' +
  '?api-version=2023-06-01&$expand=properties.linkedEnvironmentMetadata'
const POWERPLATFORM_ADMIN_ENV_URL = 'https://admin.powerplatform.microsoft.com/manage/environments/{env_id}/hub'
// Admin-center "add myself" button + confirmation labels (the panel is localized).
const SELF_ADD_BUTTON_LABELS = ['나 추가', '나를 추가', '내 계정 추가', '본인 추가', 'Add myself', 'Add me', 'Add yourself']
const SELF_ADD_CONFIRM_LABELS = ['추가', '확인', '예', 'Add', 'Confirm', 'Yes', 'OK']

interface EnvTarget {
  envId: string
  orgHost: string
  label: string
}

export interface DataverseCaptureOptions {
  /** Stored service-account credentials for unattended auto-login. */
  credentials?: { user: string; password: string }
  /** Opt-in: add the signed-in user as admin to environments it cannot reach. */
  addSelfAsAdmin?: boolean
  /** Only collect environments belonging to this tenant (skip cross-tenant/guest envs). */
  tenantId?: string
  title?: string
  partition?: string
  timeoutMs?: number
  onLog?: (line: string) => void
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Decode a JWT payload (best-effort, no verification). */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1]
    if (!part) return null
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const obj = JSON.parse(json)
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Build an in-page script that clicks the first visible element whose text
 * contains one of `labels`, returning the matched label (or ''). */
function clickByTextScript(labels: string[]): string {
  return `(() => {
    const labels = ${JSON.stringify(labels)};
    const vis = (e) => e.getClientRects && e.getClientRects().length > 0;
    const clickables = [];
    const seen = new Set();
    function collect(root) {
      if (!root || seen.has(root)) return;
      seen.add(root);
      let nodes;
      try { nodes = root.querySelectorAll('*'); } catch (e) { return; }
      for (const n of nodes) {
        const role = (n.getAttribute && (n.getAttribute('role') || '')) || '';
        const tag = n.tagName ? n.tagName.toLowerCase() : '';
        if (tag === 'button' || tag === 'a' || role === 'button' || role === 'menuitem' || role === 'link') clickables.push(n);
        if (n.shadowRoot) collect(n.shadowRoot);
        if (tag === 'iframe') { try { if (n.contentDocument) collect(n.contentDocument); } catch (e) { /* cross-origin */ } }
      }
    }
    collect(document);
    for (const lbl of labels) {
      const el = clickables.find((e) => ((e.textContent || '').replace(/\\s+/g, ' ').trim().includes(lbl)) && vis(e));
      if (el) { el.click(); return lbl; }
    }
    return '';
  })()`
}

export function captureDataverseTokens(opts: DataverseCaptureOptions): Promise<PortalTokens> {
  return new Promise((resolve) => {
    const partition = opts.partition ?? 'persist:portal'
    const ses = session.fromPartition(partition)
    const filter = {
      urls: [
        '*://*.dynamics.com/*',
        '*://*.bap.microsoft.com/*',
        '*://*.powerplatform.com/*',
        '*://*.powerplatform.microsoft.com/*'
      ]
    }
    const tokens: PortalTokens = {}
    const creds = opts.credentials
    let settled = false
    let shown = false
    let drove = false
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let lastStep = ''
    let stalls = 0
    let makerSeen = 0
    let loginAnnounced = false
    // The BAP-audience token can arrive on api.bap.microsoft.com or a regional
    // *.bap.microsoft.com host; accept whichever the maker portal used.
    const bapToken = (): string => {
      const k = Object.keys(tokens).find((h) => h.includes('bap.microsoft.com'))
      return k ? tokens[k] : ''
    }
    // The PPAC self-add (applyAdminRole) needs the api.powerplatform.com token that
    // carries the UserManagement.Users.Apply scope (the PPAC app's broad token).
    // Collect EVERY bearer sent to a *.powerplatform.com host (NOT deduped by host)
    // and pick the one with that scope; build the tenant island gateway host from
    // its tenant id. (A first/narrower token on il-*.tenant... returns 403.)
    const ppapiTokens = new Set<string>()
    function ppapiAuth(): { host: string; token: string } | null {
      for (const tok of ppapiTokens) {
        const p = decodeJwtPayload(tok)
        if (!p) continue
        if (!String(p.aud ?? '').toLowerCase().includes('api.powerplatform.com')) continue
        if (!/UserManagement\.Users\.Apply/i.test(String(p.scp ?? ''))) continue
        const tid = String(p.tid ?? '').replace(/-/g, '').toLowerCase()
        if (tid.length < 32) continue
        return { host: `${tid.slice(0, 30)}.${tid.slice(30, 32)}.tenant.api.powerplatform.com`, token: tok }
      }
      return null
    }

    const win = new BrowserWindow({
      width: 1180,
      height: 880,
      title: opts.title ?? 'Power Apps 메이커 포털 로그인',
      show: false, // hidden: unattended when credentials succeed
      autoHideMenuBar: true,
      webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true }
    })
    hardenPortalWindow(win, opts.onLog)

    function reveal(reason: string): void {
      if (shown || settled || win.isDestroyed()) return
      shown = true
      opts.onLog?.(`로그인 창을 표시합니다 (${reason}).`)
      win.show()
    }
    if (!creds) reveal('다운로드 계정 미등록 — 직접 로그인하세요')

    ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      const headers = details.requestHeaders
      const authKey = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization')
      const auth = authKey ? String(headers[authKey] ?? '') : ''
      if (auth.toLowerCase().startsWith('bearer ')) {
        let host = ''
        try {
          host = new URL(details.url).host.toLowerCase()
        } catch {
          host = ''
        }
        const token = auth.slice(7).trim()
        if (host && token && !tokens[host]) {
          tokens[host] = token
          opts.onLog?.(`토큰 캡처: ${host}`)
        }
        if (host.includes('powerplatform.com')) ppapiTokens.add(token)
      }
      // Capture the real admin-action endpoint (e.g. the self-add the PPAC
      // "나 추가" button fires) so we learn the exact URL + api-version.
      const method = String(details.method ?? '').toUpperCase()
      if (
        method === 'POST' &&
        /(bap\.microsoft\.com|powerplatform\.com|powerplatform\.microsoft\.com)/i.test(details.url) &&
        /(addadmin|\/environments\/)/i.test(details.url)
      ) {
        opts.onLog?.(`관리 API 호출 감지: ${method} ${details.url}`)
      }
      callback({ requestHeaders: headers })
    })

    function cleanup(): void {
      try {
        ses.webRequest.onBeforeSendHeaders(filter, null)
      } catch {
        /* ignore */
      }
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }

    function finish(): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      if (!win.isDestroyed()) setTimeout(() => !win.isDestroyed() && win.close(), 200)
      resolve(tokens)
    }

    async function scrapeStorage(): Promise<void> {
      if (win.isDestroyed()) return
      try {
        const json = (await win.webContents.executeJavaScript(
          '(()=>{const o=[];for(const n of ["localStorage","sessionStorage"]){const s=window[n];if(!s)continue;for(let i=0;i<s.length;i++){const k=s.key(i);o.push([k,s.getItem(k)]);}}return JSON.stringify(o);})()',
          true
        )) as string
        mergeLocalStorageTokens(tokens, JSON.parse(json))
      } catch {
        /* page navigating — retry on the next step */
      }
    }

    /** Resolve once the current navigation settles (or after `timeoutMs`). */
    function waitForSettle(timeoutMs = 20000): Promise<void> {
      return new Promise((resolve) => {
        if (win.isDestroyed() || !win.webContents.isLoading()) return resolve()
        let done = false
        const onStop = (): void => {
          if (done) return
          done = true
          try {
            win.webContents.off('did-stop-loading', onStop)
          } catch {
            /* ignore */
          }
          clearTimeout(to)
          resolve()
        }
        const to = setTimeout(onStop, timeoutMs)
        win.webContents.on('did-stop-loading', onStop)
      })
    }

    async function gotoUrl(url: string): Promise<boolean> {
      if (win.isDestroyed()) return false
      try {
        await win.loadURL(url)
        return true
      } catch {
        // ERR_ABORTED means an auth redirect (e.g. the admin center re-auths on a
        // different host) replaced this navigation — the page is still loading the
        // redirect target. Wait for it to settle instead of treating it as failure.
        await waitForSettle()
        return !win.isDestroyed()
      }
    }

    // Enumerate environments from the MAIN process (no browser-origin CORS) using
    // the captured BAP token, mirroring the Python collector's server-side call.
    async function enumerateEnvs(bap: string): Promise<EnvTarget[]> {
      let body = ''
      try {
        const r = await httpRequest(BAP_ENVIRONMENTS_URL, { headers: { Authorization: `Bearer ${bap}` } })
        if (!r.ok) {
          opts.onLog?.(`환경 목록 조회 실패: HTTP ${r.status}`)
          return []
        }
        body = await r.text()
      } catch (e) {
        opts.onLog?.(`환경 목록 조회 오류: ${e instanceof Error ? e.message : String(e)}`)
        return []
      }
      try {
        const parsed = JSON.parse(body || '{}') as { value?: Array<Record<string, unknown>> }
        const out: EnvTarget[] = []
        let skippedDev = 0
        let skippedTenant = 0
        const wantTenant = (opts.tenantId ?? '').toLowerCase()
        for (const item of parsed.value ?? []) {
          const envId = String(item.name ?? '')
          const props = (item.properties ?? {}) as Record<string, unknown>
          const meta = (props.linkedEnvironmentMetadata ?? {}) as Record<string, unknown>
          const sku = String(props.environmentSku ?? '').toLowerCase()
          if (!envId) continue
          // Skip environments that belong to a different tenant (guest access).
          const envTenant = String(props.tenantId ?? meta.tenantId ?? '').toLowerCase()
          if (wantTenant && envTenant && envTenant !== wantTenant) {
            skippedTenant += 1
            continue
          }
          // Developer environments never accumulate Copilot transcripts.
          if (sku === 'developer') {
            skippedDev += 1
            continue
          }
          let orgHost = ''
          try {
            orgHost = new URL(String(meta.instanceUrl ?? '')).host.toLowerCase()
          } catch {
            orgHost = ''
          }
          if (!orgHost) continue
          out.push({ envId, orgHost, label: String(props.displayName ?? meta.friendlyName ?? orgHost) })
        }
        if (skippedDev) opts.onLog?.(`개발자 환경 ${skippedDev}개 제외`)
        if (skippedTenant) opts.onLog?.(`다른 테넌트 환경 ${skippedTenant}개 제외`)
        return out
      } catch {
        opts.onLog?.('환경 목록 응답을 해석하지 못했습니다.')
        return []
      }
    }

    /** Load `url` and poll the MSAL cache until `orgHost`'s token appears. */
    async function mintVia(url: string, orgHost: string): Promise<boolean> {
      if (!(await gotoUrl(url))) return false
      for (let i = 0; i < 4; i++) {
        await sleep(2500)
        await scrapeStorage()
        if (tokens[orgHost]) return true
      }
      return false
    }

    /** Mint an environment's org token by visiting maker pages that read its
     * Dataverse (home → solutions), then the org web app directly as a last
     * resort (mirrors the Python collector's three-step fallback). */
    async function mintEnv(t: EnvTarget): Promise<boolean> {
      if (await mintVia(`https://make.powerapps.com/environments/${t.envId}/home`, t.orgHost)) return true
      if (await mintVia(`https://make.powerapps.com/environments/${t.envId}/solutions`, t.orgHost)) return true
      if (await mintVia(`https://${t.orgHost}/`, t.orgHost)) return true
      return false
    }

    /** Run the deep (shadow-DOM + iframe piercing) click script in EVERY frame —
     * PPAC renders its buttons inside Fluent web components / iframes that a plain
     * document.querySelector can't reach (Playwright pierces them natively). */
    async function clickByTextAllFrames(labels: string[]): Promise<string> {
      if (win.isDestroyed()) return ''
      const script = clickByTextScript(labels)
      const frames = win.webContents.mainFrame?.framesInSubtree ?? []
      for (const f of frames) {
        try {
          const r = (await f.executeJavaScript(script, true)) as string
          if (typeof r === 'string' && r) return r
        } catch {
          /* frame gone or cross-origin exec restriction */
        }
      }
      return ''
    }

    /** Add the signed-in user as System Administrator via the PPAC
     * "applyAdminRole" API — the exact call the "나 추가" button makes. It needs an
     * api.powerplatform.com-audience token sent to the tenant island gateway
     * *.tenant.api.powerplatform.com; loading the admin hub makes PPAC acquire it,
     * which we sniff. Falls back to UI/manual. Never throws. */
    async function selfAddAdmin(t: EnvTarget): Promise<boolean> {
      opts.onLog?.(`  ↳ ${t.label}: 시스템 관리자로 추가 중(applyAdminRole)…`)
      // Load the admin hub so PPAC acquires + uses its api.powerplatform.com token.
      await gotoUrl(POWERPLATFORM_ADMIN_ENV_URL.replace('{env_id}', t.envId))
      let auth = ppapiAuth()
      for (let i = 0; i < 18 && !auth; i++) {
        await sleep(2000)
        auth = ppapiAuth()
      }
      if (auth) {
        try {
          const url = `https://${auth.host}/usermanagement/environments/${t.envId}/user/applyAdminRole?api-version=2022-03-01-preview`
          const r = await httpRequest(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${auth.token}`, Accept: 'application/json' }
          })
          if (r.ok) {
            opts.onLog?.(`  ✓ ${t.label}: 시스템 관리자로 추가했습니다(applyAdminRole ${r.status}).`)
            return true
          }
          const body = (await r.text()).slice(0, 200)
          opts.onLog?.(`  ↳ ${t.label}: applyAdminRole 실패 ${r.status} ${body}`)
        } catch (e) {
          opts.onLog?.(`  ↳ ${t.label}: applyAdminRole 오류 ${e instanceof Error ? e.message : String(e)}`)
        }
      } else {
        opts.onLog?.(`  ↳ ${t.label}: 적용 권한이 있는 토큰을 캡처하지 못했습니다 — 관리 센터로 재시도합니다.`)
      }
      return selfAddAdminViaUi(t)
    }

    /** Fallback: drive the admin-center "멤버십 → 나 추가" panel (never throws). */
    async function selfAddAdminViaUi(t: EnvTarget): Promise<boolean> {
      opts.onLog?.(`  ↳ ${t.label}: 관리 센터에서 나를 시스템 관리자로 추가 시도 중…`)
      if (!(await gotoUrl(POWERPLATFORM_ADMIN_ENV_URL.replace('{env_id}', t.envId)))) return false
      await sleep(6000) // PPAC SPA is heavy — let the env hub render
      // The Python collector finds "나 추가" directly on /hub; try that first.
      let clicked = await clickByTextAllFrames(SELF_ADD_BUTTON_LABELS)
      if (!clicked) {
        // Otherwise open the "시스템 관리자(멤버십)" flyout, then retry.
        const opened = await clickByTextAllFrames(['멤버십', 'Membership', '시스템 관리자', 'System administrator'])
        if (opened) opts.onLog?.(`  ↳ ${t.label}: ‘${opened}’ 패널을 엽니다.`)
        await sleep(3500)
        clicked = await clickByTextAllFrames(SELF_ADD_BUTTON_LABELS)
      }
      if (!clicked) {
        reveal('관리 센터에서 직접 추가 필요')
        try {
          win.focus()
        } catch {
          /* ignore */
        }
        opts.onLog?.(
          `  ↳ ${t.label}: 자동 클릭 실패 — 열린 관리 센터 창에서 “＋ 나 추가”를 직접 클릭하세요(권한이 반영되면 수집을 이어갑니다).`
        )
        return false
      }
      opts.onLog?.(`  ↳ ${t.label}: ‘${clicked}’ 클릭`)
      await sleep(2000)
      await clickByTextAllFrames(SELF_ADD_CONFIRM_LABELS)
      await sleep(5000)
      opts.onLog?.(`  ✓ ${t.label}: 나를 시스템 관리자로 추가했습니다(권한 반영을 기다립니다).`)
      return true
    }

    /** HTTP status of a 1-row conversationtranscript read with `token` (0 on network error). */
    async function testReadAccess(orgHost: string, token: string): Promise<number> {
      try {
        const r = await httpRequest(
          `https://${orgHost}/api/data/v9.2/conversationtranscripts?$top=1&$select=conversationtranscriptid`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/json',
              'OData-MaxVersion': '4.0',
              'OData-Version': '4.0'
            }
          }
        )
        return r.status
      } catch {
        return 0
      }
    }

    /** A minted token can still lack the conversationtranscript privilege (403).
     * When the operator opted in, add self as admin and wait for the role to apply
     * — done HERE while the browser is open so the later collector query succeeds. */
    async function ensureReadAccess(t: EnvTarget, token: string): Promise<void> {
      let status = await testReadAccess(t.orgHost, token)
      if (status !== 403) return
      opts.onLog?.(`${t.label}: 대화 기록 읽기 권한 없음(403) — 시스템 관리자로 추가합니다…`)
      const added = await selfAddAdmin(t)
      // Poll for the role to take effect — covers API/auto-UI propagation AND a
      // manual "나 추가" click in the revealed window (longer wait when manual).
      const tries = added ? 6 : 18
      for (let i = 0; i < tries; i++) {
        await sleep(5000)
        status = await testReadAccess(t.orgHost, token)
        if (status !== 403) break
      }
      opts.onLog?.(
        status === 403
          ? `${t.label}: 아직 권한이 없습니다 — 잠시 후 다시 수집하거나 권한을 확인하세요.`
          : `${t.label}: 시스템 관리자 권한이 적용되었습니다.`
      )
    }

    async function drive(): Promise<void> {
      if (drove || settled) return
      drove = true
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
      try {
        opts.onLog?.('메이커 포털 도착 — 환경 목록을 불러옵니다…')
        // The BAP token is only seen as an outbound request (not in localStorage),
        // so wait for the env-list page to call it; reload to re-fire the call if
        // it stalls (e.g. the page was served from cache).
        let bap = bapToken()
        for (let i = 0; i < 18 && !bap; i++) {
          await sleep(2500)
          await scrapeStorage()
          bap = bapToken()
          if (!bap && (i === 4 || i === 11)) {
            opts.onLog?.('환경 목록 토큰 대기 중… 페이지를 새로고침합니다.')
            try {
              win.webContents.reload()
            } catch {
              /* ignore */
            }
          }
        }
        if (!bap) {
          opts.onLog?.('BAP 토큰을 캡처하지 못했습니다 — 포털 로그인 또는 환경 접근 권한을 확인하세요.')
          finish()
          return
        }
        opts.onLog?.('BAP 토큰 확보 — 환경을 열거합니다…')
        const targets = await enumerateEnvs(bap)
        if (!targets.length) {
          opts.onLog?.('접근 가능한 환경을 찾지 못했습니다.')
          finish()
          return
        }
        opts.onLog?.(`환경 ${targets.length}개 확인 — 환경별 토큰을 발급합니다…`)
        for (const t of targets) {
          if (settled || win.isDestroyed()) break
          if (!tokens[t.orgHost]) {
            opts.onLog?.(`토큰 발급 중: ${t.label}…`)
            let ok = await mintEnv(t)
            if (!ok && opts.addSelfAsAdmin) {
              if (await selfAddAdmin(t)) ok = await mintEnv(t)
            }
            if (!ok) {
              opts.onLog?.(`건너뜀(접근 불가): ${t.label}`)
              continue
            }
          }
          const token = tokens[t.orgHost]
          // A token can mint yet lack the transcript read privilege (403). When
          // opted in, verify access and self-add as admin to fix it now (while
          // the browser is still open) so the collector's later query succeeds.
          if (token && opts.addSelfAsAdmin) await ensureReadAccess(t, token)
          opts.onLog?.(`토큰 확보: ${t.label}`)
        }
      } catch (e) {
        opts.onLog?.(`환경 토큰 발급 중 오류: ${e instanceof Error ? e.message : String(e)}`)
      }
      finish()
    }

    async function execLogin(doClick: boolean): Promise<string> {
      if (!creds || win.isDestroyed()) return ''
      try {
        const r = await win.webContents.executeJavaScript(loginScript(creds.user, creds.password, doClick), true)
        return typeof r === 'string' ? r : 'none'
      } catch {
        return ''
      }
    }

    async function tick(): Promise<void> {
      if (settled || drove || win.isDestroyed()) return
      let host = ''
      try {
        host = new URL(win.webContents.getURL()).host.toLowerCase()
      } catch {
        return
      }
      const isLogin =
        host.includes('login.microsoftonline.com') ||
        host.includes('login.microsoft.com') ||
        host.includes('login.live.com')
      if (isLogin) {
        makerSeen = 0
        if (!creds) {
          reveal('로그인 필요')
          return
        }
        if (!loginAnnounced) {
          loginAnnounced = true
          opts.onLog?.('로그인 페이지 감지 — 자동 로그인 중…')
        }
        const step = await execLogin(false)
        if (step && step !== lastStep) {
          lastStep = step
          stalls = 0
          if (step !== 'none' && !step.startsWith('err')) {
            opts.onLog?.(`자동 로그인: ${step}`)
            await execLogin(true)
          }
          return
        }
        stalls += 1
        if (stalls === 4) await execLogin(true)
        if (stalls >= 13) reveal('자동 로그인이 진행되지 않습니다(MFA·계정/비밀번호 오류 가능)')
        return
      }
      // Signed in and on the maker portal → run the unattended drive once.
      // Require two consecutive observations so a transient pre-login redirect
      // through make.powerapps.com does not kick off the driver prematurely.
      if (host.includes('make.powerapps.com')) {
        makerSeen += 1
        if (makerSeen >= 2) void drive()
      } else {
        makerSeen = 0
      }
    }

    const startPoll = (): void => {
      if (!pollTimer && !drove && !settled) pollTimer = setInterval(() => void tick(), 1500)
    }
    // Any of these fire once a navigation settles (including the login page we
    // were redirected to), so the driver loop starts even when the initial load
    // to make.powerapps.com is aborted by an auth redirect.
    win.webContents.on('did-finish-load', startPoll)
    win.webContents.on('did-stop-loading', startPoll)
    win.webContents.on('did-navigate', startPoll)

    const timer = setTimeout(() => {
      reveal('시간 초과')
      finish()
    }, opts.timeoutMs ?? 480_000)

    win.on('closed', () => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        cleanup()
        resolve(tokens)
      }
    })

    opts.onLog?.(creds ? '자동 로그인으로 Dataverse 토큰을 수집합니다…' : '포털 로그인 후 자동으로 환경 토큰을 수집합니다…')
    // Auth redirects ABORT this navigation (ERR_ABORTED); that is NORMAL, not
    // fatal (Python suppresses the same goto error). Never finish() here — the
    // poll loop drives login + capture. A safety timer starts the loop in case
    // no navigation event fires.
    setTimeout(startPoll, 3000)
    win.loadURL(POWERAPPS_MAKER_ENVS_URL).catch((e) => {
      opts.onLog?.(`초기 페이지 이동 리디렉션(정상일 수 있음): ${e instanceof Error ? e.message : String(e)}`)
    })
  })
}
