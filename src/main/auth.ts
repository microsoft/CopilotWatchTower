/**
 * App-only (client credentials) auth, ported from services/auth.py.
 * Reads tenant/client_id/client_secret from the store's settings table
 * (client_secret is DPAPI-protected) and mints Graph tokens via msal-node.
 */
import { ConfidentialClientApplication } from '@azure/msal-node'
import { getSettingText, getSecretRaw } from './db'
import { dpapiUnprotect } from './secrets'

const GRAPH_DEFAULT_SCOPE = 'https://graph.microsoft.com/.default'

let cca: ConfidentialClientApplication | null = null
let cached: { token: string; exp: number } | null = null

export function hasCredentials(): boolean {
  return Boolean(getSettingText('tenant_id') && getSettingText('client_id') && getSecretRaw('client_secret'))
}

function client(): ConfidentialClientApplication {
  if (cca) return cca
  const tenant = getSettingText('tenant_id')
  const clientId = getSettingText('client_id')
  const secretRaw = getSecretRaw('client_secret')
  if (!tenant || !clientId || !secretRaw) {
    throw new Error('No stored credentials — onboarding required')
  }
  const clientSecret = dpapiUnprotect(secretRaw)
  cca = new ConfidentialClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenant}`,
      clientSecret
    }
  })
  return cca
}

export async function getAppToken(): Promise<string> {
  const now = Date.now()
  if (cached && now < cached.exp - 60_000) return cached.token
  const res = await client().acquireTokenByClientCredential({ scopes: [GRAPH_DEFAULT_SCOPE] })
  if (!res?.accessToken) throw new Error('Token acquisition failed')
  cached = {
    token: res.accessToken,
    exp: res.expiresOn ? res.expiresOn.getTime() : now + 3_000_000
  }
  return cached.token
}

/** Drop cached state (e.g. after a 401 or credential change). */
export function resetAuth(): void {
  cca = null
  cached = null
}
