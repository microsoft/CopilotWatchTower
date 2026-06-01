@echo off
setlocal enableextensions
REM ============================================================
REM  CopilotWatchTower uninstaller
REM ============================================================

echo.
echo === CopilotWatchTower Uninstaller ===
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$p = Get-AppxPackage -Name 'CopilotWatchTower.Dev'; if ($p) { Remove-AppxPackage -Package $p.PackageFullName; Write-Host '      Package removed.' } else { Write-Host '      Package not found (already uninstalled).' }"

echo.
echo === Done. ===
echo.
pause
exit /b 0
