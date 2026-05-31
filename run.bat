@echo off
rem CopilotWatchTower launcher.
rem
rem Double-click this file in Explorer OR run from cmd:
rem     run.bat
rem
rem It starts the GUI detached from the terminal so closing this window
rem does not kill the app.

setlocal
set "ROOT=%~dp0"
start "" "%ROOT%.venv\Scripts\copilot-watchtower.exe"
endlocal
