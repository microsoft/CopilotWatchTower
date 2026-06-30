/**
 * Onboarding orchestration, ported from auth.py (device code) + appreg.py +
 * consent_server.py. Admin signs in via device code → we create an Entra app
 * registration + secret, request admin consent (loopback callback), then store
 * credentials in a new profile.
 */
import { PublicClientApplication } from '@azure/msal-node'
import { shell } from 'electron'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import * as profiles from './profiles'
import { persistTokenCache } from './tokenCache'

const BOOTSTRAP_CLIENT_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e'
const GRAPH = 'https://graph.microsoft.com/v1.0'
const GRAPH_RESOURCE_ID = '00000003-0000-0000-c000-000000000000'

const DELEGATED_BOOTSTRAP_SCOPES = [
  'Application.ReadWrite.All',
  'AppRoleAssignment.ReadWrite.All',
  'Directory.Read.All',
  // Lets the bootstrap admin grant the app-only collector the Exchange/Purview
  // audit-log role via Graph beta /roleManagement/exchange (matches the Python
  // onboarding scope set). Consented here so the seeded refresh token covers it.
  'RoleManagement.ReadWrite.Exchange',
  'ReportSettings.ReadWrite.All',
  'eDiscovery.ReadWrite.All',
  'CopilotPackages.Read.All',
  'AppCatalog.Read.All'
]

// Purview eDiscovery export-download audience. The Graph control plane uses a
// graph.microsoft.com token, but the export *package* download requires this
// second audience. Warmed silently at onboarding off the multi-resource refresh
// token so downloads never trigger a separate sign-in.
const PURVIEW_EDISCOVERY_RESOURCE_ID = 'b26e684c-5068-4120-a679-64a5d2c909d9'
const PURVIEW_EXPORT_SCOPE = `${PURVIEW_EDISCOVERY_RESOURCE_ID}/.default`

// Application permissions (app roles) granted to the created app registration.
const APP_ROLE_IDS = [
  '839c90ab-5771-41ee-aef8-a562e8487c1e', // AiEnterpriseInteraction.Read.All
  'df021288-bdef-4463-88db-98f22de89214', // User.Read.All
  '498476ce-e0fe-48b0-b801-37ba7e2685c6', // Organization.Read.All
  'b0afded3-3588-46d8-8b3d-9842eff778da', // AuditLog.Read.All
  '5e1e9171-754d-478c-812c-f1755a9a4c2d', // AuditLogsQuery.Read.All
  '230c1aed-a721-4c5d-9cb4-a90514e508ef', // Reports.Read.All
  '2a60023f-3219-47ad-baa4-40e17cd02a1d', // ReportSettings.ReadWrite.All
  'd3acceb6-4673-47c0-aeac-582f2c7cf72c', // AgentRegistration.Read.All
  '72f0655d-6228-4ddc-8e1b-164973b9213b', // CopilotPackages.Read.All
  '556d5e2e-1081-4452-8147-26c3a1b06f58', // CopilotPolicy settings read
  '9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30' // Application.Read.All
]
const EDISCOVERY_DELEGATED_SCOPE_ID = 'acb8f680-0834-4146-b69e-4ab1b39745ad'

export interface DeviceCode {
  userCode: string
  verificationUri: string
  message: string
}
export type OnProgress = (message: string, percent: number) => void
export type OnDeviceCode = (dc: DeviceCode) => void

interface MsClaims {
  tid?: string
  preferred_username?: string
}

async function deviceLogin(
  onCode: OnDeviceCode
): Promise<{ token: string; tenantId: string; upn: string; cacheBlob: string | null }> {
  const pca = new PublicClientApplication({
    auth: { clientId: BOOTSTRAP_CLIENT_ID, authority: 'https://login.microsoftonline.com/organizations' }
  })
  const res = await pca.acquireTokenByDeviceCode({
    scopes: DELEGATED_BOOTSTRAP_SCOPES,
    deviceCodeCallback: (r) => onCode({ userCode: r.userCode, verificationUri: r.verificationUri, message: r.message })
  })
  if (!res?.accessToken) throw new Error('디바이스 코드 로그인에 실패했습니다.')
  const claims = (res.idTokenClaims as MsClaims) || {}
  const tenantId = res.account?.tenantId || claims.tid || ''
  const upn = res.account?.username || claims.preferred_username || ''
  if (!tenantId) throw new Error('테넌트 정보를 확인할 수 없습니다.')
  // Warm the Purview eDiscovery export audience so later export *downloads* mint
  // that second-audience token silently (the device-code flow can only consent
  // to one resource). MSAL refresh tokens are multi-resource, so this is silent
  // off the just-signed-in account. Best-effort — mirrors auth.py warm_scopes().
  if (res.account) {
    try {
      await pca.acquireTokenSilent({ account: res.account, scopes: [PURVIEW_EXPORT_SCOPE] })
    } catch {
      /* export audience not pre-consented — download may prompt later */
    }
  }
  // Capture the serialized MSAL cache (refresh token) so onboarding can seed the
  // per-profile delegated cache at profile-creation time. This is what lets
  // eDiscovery collection acquire tokens silently afterwards (no second prompt).
  let cacheBlob: string | null = null
  try {
    cacheBlob = pca.getTokenCache().serialize()
  } catch {
    cacheBlob = null
  }
  return { token: res.accessToken, tenantId, upn, cacheBlob }
}

async function gpost(token: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(GRAPH + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`Graph POST ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return (await res.json()) as Record<string, unknown>
}

async function registerApp(
  token: string,
  redirectUri: string
): Promise<{
  appObjectId: string
  clientId: string
  spObjectId: string
  secret: string
  secretExpires: string
  displayName: string
}> {
  const rand = randomBytes(3).toString('hex')
  const displayName = `CopilotWatchTower-${hostname()}-${rand}`.slice(0, 90)
  const app = await gpost(token, '/applications', {
    displayName,
    signInAudience: 'AzureADMyOrg',
    description: 'Tenant-admin tool that collects Microsoft 365 Copilot interaction history.',
    tags: ['CopilotWatchTower', 'TenantAdminTool'],
    web: { redirectUris: [redirectUri] },
    requiredResourceAccess: [
      {
        resourceAppId: GRAPH_RESOURCE_ID,
        resourceAccess: [
          ...APP_ROLE_IDS.map((id) => ({ id, type: 'Role' })),
          { id: EDISCOVERY_DELEGATED_SCOPE_ID, type: 'Scope' }
        ]
      }
    ]
  })
  const appObjectId = String(app.id)
  const clientId = String(app.appId)
  const sp = await gpost(token, '/servicePrincipals', {
    appId: clientId,
    tags: ['WindowsAzureActiveDirectoryIntegratedApp']
  })
  const end = new Date(Date.now() + 180 * 24 * 3600 * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
  const pw = await gpost(token, `/applications/${appObjectId}/addPassword`, {
    passwordCredential: { displayName: `copilot-watchtower-${rand}`, endDateTime: end }
  })
  return {
    appObjectId,
    clientId,
    spObjectId: String(sp.id),
    secret: String(pw.secretText),
    secretExpires: String(pw.endDateTime || end),
    displayName
  }
}

interface ConsentHandle {
  redirectUri: string
  state: string
  wait: (timeoutMs: number) => Promise<{ ok: boolean; error?: string }>
}

/**
 * Poll Graph until the loopback redirect URI is observed on the app.
 * Entra's Graph read replica and its /adminconsent auth endpoint propagate
 * writes on independent schedules, so a blind sleep is unreliable; confirming
 * the URI on the read replica gives far higher confidence the consent request
 * won't fail (admin_consent=False / AADSTS500113). Returns true once seen.
 */
async function verifyRedirectUri(
  token: string,
  appObjectId: string,
  redirectUri: string,
  timeoutMs: number,
  intervalMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(`${GRAPH}/applications/${appObjectId}?$select=web`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (res.ok) {
        const data = (await res.json()) as { web?: { redirectUris?: string[] } }
        if (data.web?.redirectUris?.includes(redirectUri)) return true
      }
    } catch {
      /* transient network/Graph error — keep polling */
    }
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}
async function startConsentServer(): Promise<ConsentHandle> {
  const state = randomBytes(8).toString('hex')
  let resolveDone!: (v: { ok: boolean; error?: string }) => void
  const done = new Promise<{ ok: boolean; error?: string }>((r) => {
    resolveDone = r
  })
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/consent-callback') {
      const s = url.searchParams.get('state')
      const admin = url.searchParams.get('admin_consent')
      const error = url.searchParams.get('error')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(
        '<html><body style="font-family:sans-serif;padding:48px;text-align:center"><h2>CopilotWatchTower</h2><p>동의가 처리되었습니다. 이 창을 닫고 앱으로 돌아가세요.</p></body></html>'
      )
      if (s !== state) resolveDone({ ok: false, error: 'state-mismatch' })
      else if (error) resolveDone({ ok: false, error })
      // Entra redirects with admin_consent=True (capital T) on success — compare
      // case-insensitively, exactly like the Python consent_server.
      else resolveDone({ ok: (admin || '').toLowerCase() === 'true' })
      setTimeout(() => server.close(), 800)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  return {
    redirectUri: `http://127.0.0.1:${port}/consent-callback`,
    state,
    wait: (timeoutMs) =>
      Promise.race([
        done,
        new Promise<{ ok: boolean; error?: string }>((r) => setTimeout(() => r({ ok: false, error: 'timeout' }), timeoutMs))
      ])
  }
}

export async function onboard(
  name: string,
  onProgress: OnProgress,
  onCode: OnDeviceCode,
  edCreds?: { user: string; password: string }
): Promise<{ ok: boolean; profileId?: string; error?: string }> {
  try {
    onProgress('관리자 로그인 대기 중…', 5)
    const { token, tenantId, upn, cacheBlob } = await deviceLogin(onCode)

    onProgress('동의 콜백 서버 준비 중…', 30)
    const consent = await startConsentServer()

    onProgress('Entra 앱 등록 생성 중…', 45)
    const app = await registerApp(token, consent.redirectUri)

    // Entra's Graph read replica and its /adminconsent auth endpoint propagate
    // writes on independent schedules. A blind sleep is unreliable — poll Graph
    // until the loopback redirect URI is confirmed on the app, then give the auth
    // endpoint a short extra settle. Without this the consent page rejects the
    // request (admin_consent=False → "consent-denied") or fails with AADSTS500113.
    onProgress('앱 등록 전파 확인 중… (최대 40초)', 55)
    const propagated = await verifyRedirectUri(token, app.appObjectId, consent.redirectUri, 40_000, 1500)
    onProgress(propagated ? '전파 확인됨 · 동의 준비 중…' : '전파 확인 시간 초과 · 그래도 진행합니다…', 60)
    await new Promise((r) => setTimeout(r, propagated ? 3_000 : 6_000))

    onProgress('관리자 동의 대기 중… (브라우저에서 동의)', 65)
    const consentUrl =
      `https://login.microsoftonline.com/${tenantId}/adminconsent` +
      `?client_id=${app.clientId}&redirect_uri=${encodeURIComponent(consent.redirectUri)}&state=${consent.state}`
    await shell.openExternal(consentUrl)
    const cres = await consent.wait(5 * 60 * 1000)
    if (!cres.ok) return { ok: false, error: `consent-${cres.error || 'denied'}` }

    onProgress('프로필 생성 중…', 85)
    const profile = profiles.createProfile(name.trim() || upn || 'profile')
    // Seed the delegated token cache in the *new profile's directory* (mirrors
    // Python's delegated_token_cache_path(repo.db_path.parent, tenant)) so later
    // eDiscovery collection reuses this login silently — no second device-code
    // prompt. The blob already carries the warmed Purview export audience too.
    persistTokenCache(dirname(profiles.profileDbPath(profile.id)), tenantId, cacheBlob ?? '')
    // Optional eDiscovery ME3 unattended-download service account (DPAPI).
    if (edCreds?.user && edCreds?.password) {
      profiles.writeProfileEdiscoveryCreds(profile.id, edCreds.user, edCreds.password)
    }
    profiles.writeProfileCredentials(profile.id, {
      tenantId,
      clientId: app.clientId,
      appObjectId: app.appObjectId,
      spObjectId: app.spObjectId,
      displayName: app.displayName,
      clientSecret: app.secret,
      secretExpires: app.secretExpires
    })
    profiles.updateProfile(profile.id, {
      tenant_id: tenantId,
      tenant_domain: upn.includes('@') ? upn.split('@')[1] : null,
      display_name: app.displayName,
      bootstrap_complete: true,
      last_used_at: new Date().toISOString()
    })
    profiles.setActiveProfile(profile.id)

    onProgress('완료', 100)
    return { ok: true, profileId: profile.id }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
