# CopilotWatchTower Web UI Workspace

This is the frontend workspace for the web-based UI shell. The PySide
application embeds the build output in a `QWebEngineView` and exposes a
Python ↔ JS bridge through `QWebChannel`.

## Quick start

```powershell
cd web
npm install
npm run dev      # http://127.0.0.1:5174  (dev server)

# Tell the desktop app to point at the dev server (Windows PowerShell)
$env:COPILOT_WATCHTOWER_WEB_DEV_URL = "http://127.0.0.1:5174"
python -m copilot_watchtower
```

For production builds:

```powershell
cd web
npm run build    # emits to web/dist/
python -m copilot_watchtower
```

The web shell is the only UI. React assets are loaded from `web/dist/` when present; otherwise the desktop app shows a static fallback page bundled with the Python package so the shell always has something to show.

## Stack

- React 18 + TypeScript
- Vite 5
- TanStack Query for data fetching/caching
- Recharts for charts
- CSS modules with a small token set

## Bridge

`src/lib/bridge.ts` exposes a typed wrapper around the `watchtower`
QWebChannel object. The Python surface is defined in
[`src/copilot_watchtower/webshell/bridge.py`](../src/copilot_watchtower/webshell/bridge.py).
