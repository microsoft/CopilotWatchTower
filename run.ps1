# CopilotWatchTower launcher (PowerShell).
#
# Usage from any PowerShell prompt:
#     .\run.ps1
#
# Launches the GUI as a detached pythonw process so closing this
# console does not terminate the app.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $root ".venv\Scripts\copilot-watchtower.exe"

if (-not (Test-Path $exe)) {
    Write-Error "Virtual environment not found at $exe. Run `pip install -e .` inside .venv first."
    exit 1
}

Start-Process -FilePath $exe -WorkingDirectory $root
Write-Host "CopilotWatchTower launched (detached). You can close this window safely."
