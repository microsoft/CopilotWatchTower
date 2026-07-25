import type { BrowserWindow } from 'electron'

/**
 * Hosts the app is allowed to hand to the OS browser. The renderer only ever
 * links to Microsoft documentation and admin portals, so anything else is a
 * navigation the app did not intend — refuse it rather than launching it.
 */
const EXTERNAL_HOST_SUFFIXES = [
  'microsoft.com',
  'microsoftonline.com',
  'microsoft.net',
  'azure.com',
  'office.com',
  'office.net',
  'sharepoint.com',
  'dynamics.com',
  'powerapps.com',
  'powerautomate.com',
  'powerplatform.com',
  'msftauth.net',
  'live.com',
  'windows.net',
  'github.com'
]

function hostAllowed(host: string): boolean {
  const h = host.toLowerCase()
  return EXTERNAL_HOST_SUFFIXES.some((suffix) => h === suffix || h.endsWith(`.${suffix}`))
}

export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return false
    if (url.username || url.password) return false
    return hostAllowed(url.hostname)
  } catch {
    return false
  }
}

export function isAllowedPrimaryNavigation(target: string, rendererEntry: string): boolean {
  try {
    const targetUrl = new URL(target)
    const entryUrl = new URL(rendererEntry)

    if (entryUrl.protocol === 'file:') {
      return targetUrl.protocol === 'file:' && targetUrl.host === entryUrl.host && targetUrl.pathname === entryUrl.pathname
    }

    if (entryUrl.protocol !== 'http:' && entryUrl.protocol !== 'https:') return false
    return targetUrl.origin === entryUrl.origin
  } catch {
    return false
  }
}

/** Web content is only ever legitimate over http(s) in an interactive portal window. */
export function isWebScheme(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * Harden an interactive sign-in / portal window.
 *
 * These windows navigate freely across Microsoft and customer-federated identity
 * providers, so an origin allowlist would break federated tenants. What they must
 * never do is leave the web: a `file:` or custom-scheme navigation inside the
 * authenticated session partition, an unmanaged child window that silently
 * inherits that partition, or an attached <webview>, are all avoidable risks.
 */
export function hardenPortalWindow(win: BrowserWindow, onLog?: (line: string) => void): void {
  const contents = win.webContents
  contents.setWindowOpenHandler(({ url }) => {
    if (!isWebScheme(url)) {
      onLog?.(`차단된 팝업(비 웹 스킴): ${url.slice(0, 120)}`)
      return { action: 'deny' }
    }
    // Auth flows do use popups; allow them but force the same safe preferences
    // instead of letting the child inherit whatever the opener asked for.
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webviewTag: false
        }
      }
    }
  })
  contents.on('will-navigate', (event, url) => {
    if (!isWebScheme(url)) {
      event.preventDefault()
      onLog?.(`차단된 이동(비 웹 스킴): ${url.slice(0, 120)}`)
    }
  })
  contents.on('will-attach-webview', (event) => {
    event.preventDefault()
    onLog?.('차단된 <webview> 부착 시도')
  })
}
