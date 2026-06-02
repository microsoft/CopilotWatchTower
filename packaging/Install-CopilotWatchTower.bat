@echo off
setlocal enableextensions
REM ============================================================
REM  CopilotWatchTower installer (self-signed MSIX)
REM  Run this file as Administrator.
REM  Place it next to:
REM    - CopilotWatchTower.msix
REM    - CopilotWatchTower.cer
REM ============================================================

cd /d "%~dp0"

set "MSIX=CopilotWatchTower.msix"
set "CER=CopilotWatchTower.cer"

echo.
echo === CopilotWatchTower Installer ===
echo.

REM --- Require administrator privileges ---
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Please run this installer as Administrator.
    echo         Right-click the file and choose "Run as administrator".
    echo.
    pause
    exit /b 1
)

if not exist "%MSIX%" (
    echo [ERROR] %MSIX% not found in this folder.
    pause
    exit /b 1
)
if not exist "%CER%" (
    echo [ERROR] %CER% not found in this folder.
    pause
    exit /b 1
)

echo [precheck] Verifying MSIX signature...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$sig = Get-AuthenticodeSignature -FilePath '%MSIX%'; if (($sig.Status -eq 'NotSigned') -or ($null -eq $sig.SignerCertificate)) { Write-Host ('[ERROR] MSIX signature missing: ' + $sig.Status); exit 2 } else { Write-Host ('      Signature detected: ' + $sig.Status) }"
if %errorlevel% neq 0 (
    echo [ERROR] %MSIX% is not properly signed.
    echo         Rebuild with signing enabled (build-msix.ps1 -CertPath ...)
    pause
    exit /b 1
)

echo [1/2] Trusting the signing certificate (LocalMachine\TrustedPeople)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference='Stop'; Import-Certificate -FilePath '%CER%' -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null; Write-Host '      Certificate trusted.'"
if %errorlevel% neq 0 (
    echo [ERROR] Failed to import certificate.
    pause
    exit /b 1
)

echo [2/2] Installing the MSIX package...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference='Stop'; Add-AppxPackage -Path '%MSIX%' -ErrorAction Stop; Write-Host '      Package installed.'"
if %errorlevel% neq 0 (
    echo [ERROR] Failed to install the MSIX package.
    pause
    exit /b 1
)

echo.
echo === Done. You can launch CopilotWatchTower from the Start menu. ===
echo.
pause
exit /b 0
