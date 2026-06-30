/**
 * Persistent, DPAPI-encrypted MSAL delegated token cache — the Electron port of
 * services/auth.py's ``delegated_token_cache_path`` + ``SerializableTokenCache``.
 *
 * Onboarding signs in once via device code (its bootstrap scopes already include
 * ``eDiscovery.ReadWrite.All``) and seeds this cache — stored *in the profile's
 * own directory*, exactly like the Python app — with the *multi-resource*
 * refresh token. Later delegated collection (Purview eDiscovery) attaches the
 * matching cache plugin and mints tokens **silently**: no second device-code
 * prompt. This is what makes eDiscovery collection "fully automated" again.
 *
 * The serialized MSAL cache (which contains the refresh token) is encrypted at
 * rest with Windows DPAPI, scoped to the current user.
 */
import type { ICachePlugin, TokenCacheContext } from '@azure/msal-node'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dpapiProtect, dpapiUnprotect } from './secrets'

/**
 * Tenant-scoped on-disk cache path *inside the profile directory*, mirroring
 * Python's ``delegated_token_cache_path(repo.db_path.parent, tenant_id)`` →
 * ``<profileDir>/.token_cache.{tid8}.bin``.
 */
export function tokenCachePath(profileDir: string, tenantId: string): string {
  const tag = (tenantId || 'common').slice(0, 8)
  return join(profileDir, `.token_cache.${tag}.bin`)
}

/** True when a persisted delegated token cache exists for the profile/tenant. */
export function hasTokenCache(profileDir: string, tenantId: string): boolean {
  return existsSync(tokenCachePath(profileDir, tenantId))
}

/** Remove the persisted cache (used by permission re-registration / reset). */
export function clearTokenCache(profileDir: string, tenantId: string): void {
  try {
    rmSync(tokenCachePath(profileDir, tenantId), { force: true })
  } catch {
    /* best effort */
  }
}

/**
 * Persist a serialized MSAL token cache for the profile/tenant (DPAPI-encrypted).
 * Used by onboarding to seed the cache from the just-signed-in account, so the
 * delegated refresh token is captured at *profile-creation* time.
 */
export function persistTokenCache(profileDir: string, tenantId: string, serialized: string): void {
  if (!serialized) return
  try {
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(tokenCachePath(profileDir, tenantId), dpapiProtect(serialized))
  } catch {
    /* best effort — a missing cache only costs one extra device-code prompt */
  }
}

/**
 * Build an MSAL ``ICachePlugin`` backed by the DPAPI-encrypted profile cache.
 * Attach to a ``PublicClientApplication`` so account enumeration and silent
 * token acquisition transparently load/save the persisted refresh token.
 */
export function makeCachePlugin(profileDir: string, tenantId: string): ICachePlugin {
  const path = tokenCachePath(profileDir, tenantId)
  return {
    async beforeCacheAccess(ctx: TokenCacheContext): Promise<void> {
      try {
        if (existsSync(path)) {
          ctx.tokenCache.deserialize(dpapiUnprotect(readFileSync(path)))
        }
      } catch {
        /* corrupt/foreign cache — ignore and fall back to interactive */
      }
    },
    async afterCacheAccess(ctx: TokenCacheContext): Promise<void> {
      if (!ctx.cacheHasChanged) return
      try {
        mkdirSync(profileDir, { recursive: true })
        writeFileSync(path, dpapiProtect(ctx.tokenCache.serialize()))
      } catch {
        /* best effort */
      }
    }
  }
}
