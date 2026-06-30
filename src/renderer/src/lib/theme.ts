/**
 * Theme system — a small palette spec per theme, with the rest of the CSS
 * variables derived so adding a theme only means picking ~10 colors.
 * Applied by writing CSS custom properties onto :root (the whole UI is built
 * on those variables), exactly like swapping a VS Code color theme.
 */
export interface Theme {
  id: string
  name: string
  mode: 'dark' | 'light'
  bg: string
  panel: string
  border: string
  text: string
  textMuted: string
  accent: string
  accent2?: string
  ok: string
  warn: string
  danger: string
}

export const THEMES: Theme[] = [
  {
    id: 'watchtower', name: 'Watchtower', mode: 'dark',
    bg: '#0a0b0d', panel: '#16181d', border: '#24262e', text: '#e7e9ee', textMuted: '#9aa1ad',
    accent: '#7c6cff', accent2: '#59b6ff', ok: '#43c267', warn: '#e7b53c', danger: '#f2585b'
  },
  {
    id: 'evangelion', name: 'EVA · NERV', mode: 'dark',
    bg: '#0a0c08', panel: '#14180f', border: '#2c3622', text: '#e8f2d6', textMuted: '#94a382',
    accent: '#9fe000', accent2: '#7b2fbe', ok: '#4fd06a', warn: '#ffae00', danger: '#ff5310'
  },
  {
    id: 'eva-01', name: 'EVA-01 초호기', mode: 'dark',
    bg: '#0d0a12', panel: '#161020', border: '#2e2342', text: '#ece4f5', textMuted: '#9d90b0',
    accent: '#8aee2a', accent2: '#7b2fbe', ok: '#7bd64a', warn: '#ffc233', danger: '#ff5a30'
  },
  {
    id: 'eva-00', name: 'EVA-00 제로호기', mode: 'dark',
    bg: '#08101a', panel: '#101c2b', border: '#21384f', text: '#dceaf5', textMuted: '#8aa0b5',
    accent: '#2f8fe0', accent2: '#ff9e1b', ok: '#3fb8a0', warn: '#ffb33c', danger: '#ff6347'
  },
  {
    id: 'eva-02', name: 'EVA-02 2호기', mode: 'dark',
    bg: '#120909', panel: '#1d1110', border: '#3a2220', text: '#f6e3df', textMuted: '#b8938e',
    accent: '#e23b2e', accent2: '#ff8a00', ok: '#5fbf6a', warn: '#ffb000', danger: '#ff4d3d'
  },
  {
    id: 'midnight', name: 'Midnight', mode: 'dark',
    bg: '#0a0e1a', panel: '#141a2b', border: '#233047', text: '#e6ecf7', textMuted: '#8b9bb8',
    accent: '#4f8cff', accent2: '#7aa2ff', ok: '#3fb37f', warn: '#e0b03a', danger: '#ef5e6f'
  },
  {
    id: 'tokyo', name: 'Tokyo Night', mode: 'dark',
    bg: '#1a1b26', panel: '#1f2335', border: '#2c3047', text: '#c0caf5', textMuted: '#8a93b5',
    accent: '#7aa2f7', accent2: '#bb9af7', ok: '#9ece6a', warn: '#e0af68', danger: '#f7768e'
  },
  {
    id: 'dracula', name: 'Dracula', mode: 'dark',
    bg: '#282a36', panel: '#2f3240', border: '#44475a', text: '#f8f8f2', textMuted: '#bcc0d6',
    accent: '#bd93f9', accent2: '#ff79c6', ok: '#50fa7b', warn: '#f1fa8c', danger: '#ff5555'
  },
  {
    id: 'nord', name: 'Nord', mode: 'dark',
    bg: '#2e3440', panel: '#353c4a', border: '#434c5e', text: '#eceff4', textMuted: '#b8c0d0',
    accent: '#88c0d0', accent2: '#81a1c1', ok: '#a3be8c', warn: '#ebcb8b', danger: '#bf616a'
  },
  {
    id: 'onedark', name: 'One Dark', mode: 'dark',
    bg: '#21252b', panel: '#282c34', border: '#3b414d', text: '#d7dae0', textMuted: '#9aa0ab',
    accent: '#61afef', accent2: '#c678dd', ok: '#98c379', warn: '#e5c07b', danger: '#e06c75'
  },
  {
    id: 'github', name: 'GitHub Dark', mode: 'dark',
    bg: '#0d1117', panel: '#161b22', border: '#30363d', text: '#e6edf3', textMuted: '#9aa5b1',
    accent: '#2f81f7', accent2: '#a371f7', ok: '#3fb950', warn: '#d29922', danger: '#f85149'
  },
  {
    id: 'monokai', name: 'Monokai', mode: 'dark',
    bg: '#1d1e19', panel: '#272822', border: '#3e3f36', text: '#f8f8f2', textMuted: '#bdbdb0',
    accent: '#a6e22e', accent2: '#fd971f', ok: '#a6e22e', warn: '#e6db74', danger: '#f92672'
  },
  {
    id: 'gruvbox', name: 'Gruvbox', mode: 'dark',
    bg: '#1d2021', panel: '#282828', border: '#3c3836', text: '#ebdbb2', textMuted: '#bdae93',
    accent: '#fabd2f', accent2: '#fe8019', ok: '#b8bb26', warn: '#fabd2f', danger: '#fb4934'
  },
  {
    id: 'catppuccin', name: 'Catppuccin', mode: 'dark',
    bg: '#1e1e2e', panel: '#262637', border: '#393952', text: '#cdd6f4', textMuted: '#a6adc8',
    accent: '#cba6f7', accent2: '#89b4fa', ok: '#a6e3a1', warn: '#f9e2af', danger: '#f38ba8'
  },
  {
    id: 'linear', name: 'Linear', mode: 'dark',
    bg: '#010102', panel: '#0f1011', border: '#23252a', text: '#f7f8f8', textMuted: '#8a8f98',
    accent: '#5e6ad2', accent2: '#828fff', ok: '#27a644', warn: '#e2b340', danger: '#eb5757'
  },
  {
    id: 'sentry', name: 'Sentry', mode: 'dark',
    bg: '#150f23', panel: '#1f1633', border: '#362d59', text: '#f4f1fa', textMuted: '#bdb8c0',
    accent: '#7c6cdd', accent2: '#c2ef4e', ok: '#5db872', warn: '#e0af68', danger: '#fa7faa'
  },
  {
    id: 'raycast', name: 'Raycast', mode: 'dark',
    bg: '#07080a', panel: '#121212', border: '#242728', text: '#f4f4f6', textMuted: '#9c9c9d',
    accent: '#ff5f57', accent2: '#57c1ff', ok: '#59d499', warn: '#ffc533', danger: '#ff6161'
  },
  {
    id: 'supabase', name: 'Supabase', mode: 'dark',
    bg: '#1c1c1c', panel: '#232323', border: '#2e2e2e', text: '#ededed', textMuted: '#9a9a9a',
    accent: '#3ecf8e', accent2: '#4ade80', ok: '#3ecf8e', warn: '#ffce3a', danger: '#ff5a4d'
  },
  {
    id: 'framer', name: 'Framer', mode: 'dark',
    bg: '#090909', panel: '#141414', border: '#262626', text: '#f5f5f5', textMuted: '#999999',
    accent: '#0099ff', accent2: '#6a4cf5', ok: '#22c55e', warn: '#ff7a3d', danger: '#ff5577'
  },
  {
    id: 'coinbase', name: 'Coinbase', mode: 'dark',
    bg: '#0a0b0d', panel: '#16181c', border: '#262a30', text: '#f0f1f3', textMuted: '#a8acb3',
    accent: '#0052ff', accent2: '#f4b000', ok: '#05b169', warn: '#f4b000', danger: '#cf202f'
  },
  {
    id: 'xai', name: 'xAI Grok', mode: 'dark',
    bg: '#0a0a0a', panel: '#191919', border: '#212327', text: '#fafaf7', textMuted: '#7d8187',
    accent: '#ff7a17', accent2: '#7c3aed', ok: '#34b27b', warn: '#e0a347', danger: '#ef4444'
  },
  {
    id: 'light', name: 'Daylight', mode: 'light',
    bg: '#f6f8fa', panel: '#ffffff', border: '#d0d7de', text: '#1f2328', textMuted: '#636c76',
    accent: '#7c6cff', accent2: '#0969da', ok: '#1a7f37', warn: '#9a6700', danger: '#cf222e'
  },
  {
    id: 'github-light', name: 'GitHub Light', mode: 'light',
    bg: '#ffffff', panel: '#f6f8fa', border: '#d0d7de', text: '#1f2328', textMuted: '#636c76',
    accent: '#0969da', accent2: '#8250df', ok: '#1a7f37', warn: '#9a6700', danger: '#cf222e'
  },
  {
    id: 'one-light', name: 'One Light', mode: 'light',
    bg: '#fafafa', panel: '#ffffff', border: '#dcdfe4', text: '#383a42', textMuted: '#696c77',
    accent: '#4078f2', accent2: '#a626a4', ok: '#50a14f', warn: '#c18401', danger: '#e45649'
  },
  {
    id: 'solarized-light', name: 'Solarized Light', mode: 'light',
    bg: '#eee8d5', panel: '#fdf6e3', border: '#ddd6c1', text: '#586e75', textMuted: '#93a1a1',
    accent: '#268bd2', accent2: '#2aa198', ok: '#859900', warn: '#b58900', danger: '#dc322f'
  },
  {
    id: 'catppuccin-latte', name: 'Catppuccin Latte', mode: 'light',
    bg: '#eff1f5', panel: '#ffffff', border: '#ccd0da', text: '#4c4f69', textMuted: '#6c6f85',
    accent: '#8839ef', accent2: '#1e66f5', ok: '#40a02b', warn: '#df8e1d', danger: '#d20f39'
  },
  {
    id: 'rose-pine-dawn', name: 'Rosé Pine Dawn', mode: 'light',
    bg: '#faf4ed', panel: '#fffaf3', border: '#dfdad9', text: '#575279', textMuted: '#797593',
    accent: '#907aa9', accent2: '#d7827e', ok: '#56949f', warn: '#ea9d34', danger: '#b4637a'
  },
  {
    id: 'gruvbox-light', name: 'Gruvbox Light', mode: 'light',
    bg: '#f2e5bc', panel: '#fbf1c7', border: '#ebdbb2', text: '#3c3836', textMuted: '#7c6f64',
    accent: '#b57614', accent2: '#af3a03', ok: '#79740e', warn: '#b57614', danger: '#9d0006'
  },
  {
    id: 'vercel', name: 'Vercel', mode: 'light',
    bg: '#fafafa', panel: '#ffffff', border: '#ebebeb', text: '#171717', textMuted: '#666666',
    accent: '#0070f3', accent2: '#7928ca', ok: '#19a974', warn: '#f5a623', danger: '#ee0000'
  },
  {
    id: 'stripe', name: 'Stripe', mode: 'light',
    bg: '#f6f9fc', panel: '#ffffff', border: '#e3e8ee', text: '#0d253d', textMuted: '#64748d',
    accent: '#635bff', accent2: '#00a4ef', ok: '#15b371', warn: '#e0a020', danger: '#df1b41'
  },
  {
    id: 'claude', name: 'Claude', mode: 'light',
    bg: '#faf9f5', panel: '#ffffff', border: '#e6dfd8', text: '#141413', textMuted: '#6c6a64',
    accent: '#cc785c', accent2: '#5db8a6', ok: '#5db872', warn: '#d4a017', danger: '#c64545'
  },
  {
    id: 'notion', name: 'Notion', mode: 'light',
    bg: '#f7f6f4', panel: '#ffffff', border: '#e5e3df', text: '#2f2c28', textMuted: '#787066',
    accent: '#5645d4', accent2: '#0075de', ok: '#1aae39', warn: '#cb912f', danger: '#e03e3e'
  },
  {
    id: 'figma', name: 'Figma', mode: 'light',
    bg: '#f7f7f5', panel: '#ffffff', border: '#e6e6e6', text: '#1a1a1a', textMuted: '#6b6b6b',
    accent: '#ff3d8b', accent2: '#7b61ff', ok: '#1ea64a', warn: '#e0a020', danger: '#f24822'
  },
  {
    id: 'posthog', name: 'PostHog', mode: 'light',
    bg: '#eeefe9', panel: '#ffffff', border: '#bfc1b7', text: '#23251d', textMuted: '#6c6e63',
    accent: '#f7a501', accent2: '#2c84e0', ok: '#2c8c66', warn: '#dd9001', danger: '#cd4239'
  },
  {
    id: 'mistral', name: 'Mistral', mode: 'light',
    bg: '#fffaeb', panel: '#ffffff', border: '#ece7d8', text: '#1f1f1f', textMuted: '#6a6a6a',
    accent: '#fa520f', accent2: '#ffb83e', ok: '#1f9d57', warn: '#ff8105', danger: '#d92020'
  }
]

// ---- color helpers ----
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const int = parseInt(v, 16)
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255]
}
function toHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')
  )
}
export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a)
  const [r2, g2, b2] = hexToRgb(b)
  return toHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t)
}
function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  const set = (k: string, v: string): void => root.style.setProperty(k, v)
  const accent2 = theme.accent2 ?? theme.accent

  set('--bg', theme.bg)
  set('--panel', theme.panel)
  set('--panel-2', mix(theme.panel, theme.text, 0.035))
  set('--panel-3', mix(theme.panel, theme.text, 0.08))
  set('--border', theme.border)
  set('--border-soft', mix(theme.border, theme.bg, 0.5))
  set('--text', theme.text)
  set('--text-muted', theme.textMuted)
  set('--text-dim', mix(theme.textMuted, theme.bg, 0.4))
  set('--accent', theme.accent)
  set('--accent-2', accent2)
  set('--accent-soft', rgba(theme.accent, 0.16))
  set('--accent-glow', rgba(theme.accent, 0.35))
  set('--ok', theme.ok)
  set('--ok-soft', rgba(theme.ok, 0.16))
  set('--warn', theme.warn)
  set('--warn-soft', rgba(theme.warn, 0.16))
  set('--danger', theme.danger)
  set('--danger-soft', rgba(theme.danger, 0.16))

  if (theme.mode === 'dark') {
    set(
      '--bg-grad',
      `radial-gradient(1200px 600px at 80% -10%, ${rgba(theme.accent, 0.1)} 0%, transparent 60%),` +
        ` radial-gradient(900px 500px at -10% 10%, ${rgba(accent2, 0.08)} 0%, transparent 55%)`
    )
    set('--shadow', '0 1px 0 rgba(255,255,255,0.03) inset, 0 10px 30px rgba(0,0,0,0.45)')
    set('--hover-tint', 'rgba(255,255,255,0.02)')
    set('--scroll', '#2a2d36')
    set('--scroll-hover', '#3a3f4b')
    set('--sidebar-bg', rgba(mix(theme.bg, '#000000', 0.22), 0.55))
  } else {
    set('--bg-grad', `radial-gradient(1000px 520px at 90% -10%, ${rgba(theme.accent, 0.06)} 0%, transparent 60%)`)
    set('--shadow', '0 1px 2px rgba(0,0,0,0.05), 0 8px 24px rgba(0,0,0,0.08)')
    set('--hover-tint', 'rgba(0,0,0,0.025)')
    set('--scroll', '#c4ccd6')
    set('--scroll-hover', '#aab2bd')
    set('--sidebar-bg', rgba(mix(theme.bg, theme.text, 0.05), 0.72))
  }
  root.setAttribute('data-theme-mode', theme.mode)
}
