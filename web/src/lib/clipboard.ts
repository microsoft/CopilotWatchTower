/**
 * Copy text to the clipboard with a fallback for environments where the
 * async Clipboard API is unavailable or blocked (e.g. the embedded
 * QtWebEngine webview, which does not expose navigator.clipboard in a
 * non-secure context). Returns true on success.
 */
export async function copyText(text: string): Promise<boolean> {
  const fallback = (value: string): boolean => {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "true");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.left = "-1000px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    } finally {
      document.body.removeChild(ta);
    }
    return ok;
  };

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to execCommand fallback
  }
  return fallback(text);
}
