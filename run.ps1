# CopilotWatchTower launcher (PowerShell).
#
# Launches the Electron app in development mode (electron-vite dev + HMR).
# Usage from any PowerShell prompt:
#     .\run.ps1
#
# The legacy Python app lives under legacy/ and is reference-only.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if (-not (Test-Path (Join-Path $root "node_modules"))) {
    Write-Host "Installing dependencies (npm ci)..."
    npm ci
}

Write-Host "Starting CopilotWatchTower (Electron dev)..."
npm run dev
