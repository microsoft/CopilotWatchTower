export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
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