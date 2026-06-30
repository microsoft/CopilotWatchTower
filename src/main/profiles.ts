/**
 * Multi-tenant profile management, ported from profiles.py.
 * Layout under %LOCALAPPDATA%/CopilotWatchTower:
 *   profiles.json (registry)  +  profiles/<id>/store.db (per-profile SQLite)
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dpapiProtect } from './secrets'

export interface ProfileEntry {
  id: string
  name: string
  tenant_id?: string | null
  tenant_domain?: string | null
  display_name?: string | null
  created_at: string
  last_used_at: string
  bootstrap_complete: boolean
}
interface Registry {
  version: number
  active_profile_id: string | null
  profiles: ProfileEntry[]
}

export function rootDir(): string {
  return join(process.env.LOCALAPPDATA || '', 'CopilotWatchTower')
}
function regPath(): string {
  return join(rootDir(), 'profiles.json')
}
export function profileDbPath(id: string): string {
  return join(rootDir(), 'profiles', id, 'store.db')
}

export function readRegistry(): Registry {
  try {
    const r = JSON.parse(readFileSync(regPath(), 'utf8'))
    return { version: r.version ?? 1, active_profile_id: r.active_profile_id ?? null, profiles: r.profiles ?? [] }
  } catch {
    return { version: 1, active_profile_id: null, profiles: [] }
  }
}
function writeRegistry(reg: Registry): void {
  mkdirSync(rootDir(), { recursive: true })
  writeFileSync(regPath(), JSON.stringify(reg, null, 2), 'utf8')
}

export function listProfiles(): { profiles: ProfileEntry[]; activeId: string | null } {
  const reg = readRegistry()
  return { profiles: reg.profiles, activeId: reg.active_profile_id }
}
export function setActiveProfile(id: string): boolean {
  const reg = readRegistry()
  const p = reg.profiles.find((x) => x.id === id)
  if (!p) return false
  reg.active_profile_id = id
  p.last_used_at = new Date().toISOString()
  writeRegistry(reg)
  return true
}
export function updateProfile(id: string, patch: Partial<ProfileEntry>): void {
  const reg = readRegistry()
  const p = reg.profiles.find((x) => x.id === id)
  if (p) Object.assign(p, patch)
  writeRegistry(reg)
}

/**
 * Remove a profile from the registry and delete its on-disk data folder
 * (profiles/<id>/, including store.db). If the deleted profile was active, the
 * active pointer falls back to the first remaining profile (or null).
 */
export function deleteProfile(id: string): boolean {
  const reg = readRegistry()
  const idx = reg.profiles.findIndex((x) => x.id === id)
  if (idx === -1) return false
  reg.profiles.splice(idx, 1)
  if (reg.active_profile_id === id) reg.active_profile_id = reg.profiles[0]?.id ?? null
  writeRegistry(reg)
  try {
    rmSync(join(rootDir(), 'profiles', id), { recursive: true, force: true })
  } catch {
    /* folder may not exist — ignore */
  }
  return true
}

function loadSchema(stripFts: boolean): string {
  let s = readFileSync(join(__dirname, '../../resources/schema.sql'), 'utf8')
  if (stripFts) {
    // FTS5 may not be available in node:sqlite — drop the virtual table + its triggers.
    s = s.replace(/CREATE VIRTUAL TABLE IF NOT EXISTS interactions_fts[\s\S]*?interactions_au[\s\S]*?END;/, '')
  }
  return s
}

export function createProfile(name: string): ProfileEntry {
  const id = randomUUID().replace(/-/g, '')
  const dir = join(rootDir(), 'profiles', id)
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'store.db'))
  try {
    db.exec(loadSchema(false))
  } catch {
    db.exec(loadSchema(true))
  }
  db.close()
  const now = new Date().toISOString()
  const entry: ProfileEntry = {
    id,
    name,
    tenant_id: null,
    tenant_domain: null,
    display_name: null,
    created_at: now,
    last_used_at: now,
    bootstrap_complete: false
  }
  const reg = readRegistry()
  reg.profiles.push(entry)
  writeRegistry(reg)
  return entry
}

export interface ProfileCreds {
  tenantId: string
  clientId: string
  appObjectId: string
  spObjectId: string
  displayName: string
  clientSecret: string
  secretExpires: string
}
export function writeProfileCredentials(id: string, creds: ProfileCreds): void {
  if (!existsSync(profileDbPath(id))) throw new Error('profile db missing')
  const db = new DatabaseSync(profileDbPath(id))
  const put = (k: string, v: Buffer): void => {
    db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v)
  }
  const txt = (k: string, v: string): void => put(k, Buffer.from(v, 'utf8'))
  txt('tenant_id', creds.tenantId)
  txt('client_id', creds.clientId)
  txt('app_object_id', creds.appObjectId)
  txt('sp_object_id', creds.spObjectId)
  txt('display_name', creds.displayName)
  txt('secret_expires_at', creds.secretExpires)
  txt('bootstrap_complete', 'true')
  put('client_secret', dpapiProtect(creds.clientSecret))
  db.close()
}

/**
 * Persist the optional eDiscovery ME3 unattended-download service account into a
 * profile's own DB (called during onboarding, before the profile is active).
 * Same keys as the Python app: ediscovery_browser_user / _password (DPAPI).
 */
export function writeProfileEdiscoveryCreds(id: string, user: string, password: string): void {
  if (!user || !password) return
  if (!existsSync(profileDbPath(id))) return
  const db = new DatabaseSync(profileDbPath(id))
  try {
    const put = (k: string, v: Buffer): void => {
      db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(
        k,
        v
      )
    }
    put('ediscovery_browser_user', Buffer.from(user, 'utf8'))
    put('ediscovery_browser_password', dpapiProtect(password))
  } finally {
    db.close()
  }
}
