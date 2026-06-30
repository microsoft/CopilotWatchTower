@echo off
rem CopilotWatchTower launcher (Electron, development mode).
rem
rem Edit anything under src\ then run this to start electron-vite dev with HMR.
rem The legacy Python app lives under legacy\ and is reference-only.

setlocal
set "ROOT=%~dp0"
cd /d "%ROOT%"

if not exist "%ROOT%node_modules" (
    echo Installing dependencies (npm ci)...
    call npm ci
    if %errorlevel% neq 0 (
        echo [!] npm ci failed.
        pause
        exit /b 1
    )
)

echo Starting CopilotWatchTower (Electron dev)...
call npm run dev
endlocal
