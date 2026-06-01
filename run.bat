@echo off
rem CopilotWatchTower launcher.
rem
rem Edit any code (Python or web/src) then run this. It rebuilds the web UI
rem and starts the app. Python changes apply automatically (editable install).

setlocal
set "ROOT=%~dp0"

echo Building web UI...
call npm --prefix "%ROOT%web" run build
if %errorlevel% neq 0 (
    echo [!] Web build failed.
    pause
    exit /b 1
)

echo Starting CopilotWatchTower...
start "" "%ROOT%.venv\Scripts\copilot-watchtower.exe"
endlocal
