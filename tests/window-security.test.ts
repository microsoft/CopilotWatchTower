import { describe, expect, it } from 'vitest'
import { isAllowedPrimaryNavigation, isSafeExternalUrl, isWebScheme } from '../src/main/windowSecurity'

describe('primary window security policy', () => {
  it('opens only credential-free HTTPS URLs on allowlisted Microsoft hosts', () => {
    expect(isSafeExternalUrl('https://microsoft.com/devicelogin')).toBe(true)
    expect(isSafeExternalUrl('https://user:password@example.com/')).toBe(false)
    expect(isSafeExternalUrl('http://example.com/')).toBe(false)
    expect(isSafeExternalUrl('file:///C:/Windows/System32/calc.exe')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('not a url')).toBe(false)
    expect(isSafeExternalUrl('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')).toBe(true)
    expect(isSafeExternalUrl('https://admin.powerplatform.microsoft.com/')).toBe(true)
  })

  it('refuses hosts outside the allowlist, including lookalikes', () => {
    expect(isSafeExternalUrl('https://example.com/')).toBe(false)
    expect(isSafeExternalUrl('https://microsoft.com.evil.test/')).toBe(false)
    expect(isSafeExternalUrl('https://notmicrosoft.com/')).toBe(false)
  })

  it('allows only web schemes inside interactive portal windows', () => {
    expect(isWebScheme('https://login.microsoftonline.com/')).toBe(true)
    expect(isWebScheme('http://localhost:5173/')).toBe(true)
    expect(isWebScheme('file:///C:/Windows/System32/config/SAM')).toBe(false)
    expect(isWebScheme('javascript:alert(1)')).toBe(false)
    expect(isWebScheme('ms-appinstaller:?source=https://evil.test/x.msix')).toBe(false)
    expect(isWebScheme('nope')).toBe(false)
  })

  it('keeps development navigation on the renderer origin', () => {
    const entry = 'http://localhost:5173/'

    expect(isAllowedPrimaryNavigation('http://localhost:5173/settings?tab=security', entry)).toBe(true)
    expect(isAllowedPrimaryNavigation('http://127.0.0.1:5173/', entry)).toBe(false)
    expect(isAllowedPrimaryNavigation('https://example.com/', entry)).toBe(false)
  })

  it('keeps packaged navigation on the renderer file', () => {
    const entry = 'file:///C:/Program%20Files/CopilotWatchTower/out/renderer/index.html'

    expect(isAllowedPrimaryNavigation(`${entry}#/settings`, entry)).toBe(true)
    expect(
      isAllowedPrimaryNavigation(
        'file:///C:/Program%20Files/CopilotWatchTower/out/renderer/other.html',
        entry
      )
    ).toBe(false)
    expect(isAllowedPrimaryNavigation('file:///C:/Windows/System32/drivers/etc/hosts', entry)).toBe(false)
  })
})