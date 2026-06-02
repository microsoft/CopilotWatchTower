<#
.SYNOPSIS
    Build (and optionally sign) an MSIX package for CopilotWatchTower.

.DESCRIPTION
    End-to-end pipeline:
      1. Run PyInstaller to produce dist\CopilotWatchTower\ (skippable).
      2. Stage the bundle + Assets + a patched AppxManifest.xml.
      3. Pack with makeappx.exe.
      4. Optionally sign with signtool.exe.

    The Identity Name / Publisher in the manifest MUST match the signing
    certificate subject exactly, so this script patches them from the
    parameters below at build time instead of hard-coding them.

.PARAMETER Publisher
    Certificate subject string, e.g. "CN=Contoso Tenant Tools, O=Contoso, C=US".
    Must match the signing certificate exactly.

.PARAMETER IdentityName
    Package identity name, e.g. "Contoso.CopilotWatchTower".

.PARAMETER PublisherDisplayName
    Friendly publisher name shown in the installer UI.

.PARAMETER Version
    Four-part package version, e.g. "0.1.0.0".

.PARAMETER CertPath
    Optional path to a .pfx code-signing certificate. If supplied, the
    package is signed. If omitted, packing stops after makeappx.

.PARAMETER CertPassword
    Optional password for the .pfx. Prefer passing a SecureString or
    leaving blank to be prompted by signtool.

.PARAMETER CertThumbprint
    Optional SHA-1 thumbprint of a code-signing certificate already
    installed in the certificate store. Used for DigiCert KeyLocker
    (cloud HSM) signing where the private key never leaves the HSM and
    no .pfx is available. Takes precedence over -CertPath when supplied.

.PARAMETER TimestampUrl
    RFC 3161 timestamp server URL. Defaults to DigiCert's.

.PARAMETER SkipBuild
    Skip the PyInstaller step and reuse an existing dist\CopilotWatchTower\.

.PARAMETER WebOnly
    Fast path for web-UI-only changes. Skips PyInstaller entirely, rebuilds
    web\dist (npm run build), refreshes it inside the existing bundle, then
    re-packs and re-signs. Requires a prior full build.

.EXAMPLE
    .\build-msix.ps1 -Publisher "CN=Contoso Tenant Tools" `
                     -IdentityName "Contoso.CopilotWatchTower" `
                     -PublisherDisplayName "Contoso Tenant Tools" `
                     -Version "0.1.0.0" `
                     -CertPath .\codesign.pfx
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Publisher,

    [Parameter(Mandatory = $true)]
    [string]$IdentityName,

    [Parameter(Mandatory = $true)]
    [string]$PublisherDisplayName,

    [string]$Version = "0.1.0.0",

    [string]$CertPath,

    [string]$CertPassword,

    [string]$CertThumbprint,

    [string]$TimestampUrl = "http://timestamp.digicert.com",

    [switch]$SkipBuild,

    [switch]$WebOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# --- Paths ---------------------------------------------------------------
$PackagingDir = $PSScriptRoot
$RepoRoot     = Split-Path -Parent $PackagingDir
$DistDir      = Join-Path $RepoRoot "dist\CopilotWatchTower"
$AssetsDir    = Join-Path $PackagingDir "Assets"
$ManifestSrc  = Join-Path $PackagingDir "AppxManifest.xml"
$StagingDir   = Join-Path $RepoRoot "build\msix-staging"
$OutputMsix   = Join-Path $RepoRoot "dist\CopilotWatchTower.msix"
$SpecFile     = Join-Path $PackagingDir "copilot-watchtower.spec"
$VenvPyInstaller = Join-Path $RepoRoot ".venv\Scripts\pyinstaller.exe"

function Get-SdkBuildTools {
    <#
        Acquire makeappx.exe / signtool.exe without a full Windows SDK
        install (and without admin rights) by downloading the
        Microsoft.Windows.SDK.BuildTools NuGet package (a plain .zip) and
        extracting it into build\sdk-buildtools\. The package ships the
        signing/packaging tools under bin\<ver>\x64\.
    #>
    $cacheDir = Join-Path $RepoRoot "build\sdk-buildtools"
    $extractDir = Join-Path $cacheDir "extracted"

    # Reuse a previous extraction if the tools are already present.
    if (Test-Path $extractDir) {
        $existing = Get-ChildItem -Path $extractDir -Recurse -Filter "makeappx.exe" -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match "\\x64\\" } |
            Select-Object -First 1
        if ($existing) { return Split-Path -Parent $existing.FullName }
    }

    New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
    $nupkg = Join-Path $cacheDir "sdk-buildtools.zip"

    # Resolve the latest stable version from the NuGet flat-container index.
    Write-Host "==> Acquiring Windows SDK BuildTools via NuGet (no admin needed)..." -ForegroundColor Cyan
    $pkgId = "microsoft.windows.sdk.buildtools"
    $indexUrl = "https://api.nuget.org/v3-flatcontainer/$pkgId/index.json"
    $oldPref = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    try {
        $versions = (Invoke-RestMethod -Uri $indexUrl).versions |
            Where-Object { $_ -notmatch "preview" }
        $version = $versions | Select-Object -Last 1
        if (-not $version) { throw "No stable BuildTools version found on NuGet." }

        $pkgUrl = "https://api.nuget.org/v3-flatcontainer/$pkgId/$version/$pkgId.$version.nupkg"
        Write-Host "    Downloading $pkgId $version ..." -ForegroundColor DarkGray
        Invoke-WebRequest -Uri $pkgUrl -OutFile $nupkg

        if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
        Expand-Archive -Path $nupkg -DestinationPath $extractDir -Force
    }
    finally {
        $ProgressPreference = $oldPref
    }

    $makeappx = Get-ChildItem -Path $extractDir -Recurse -Filter "makeappx.exe" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match "\\x64\\" } |
        Select-Object -First 1
    if (-not $makeappx) {
        throw "BuildTools package downloaded but makeappx.exe (x64) was not found inside it."
    }
    return Split-Path -Parent $makeappx.FullName
}

function Find-WindowsKitTool {
    param([Parameter(Mandatory = $true)][string]$Name)

    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $kitRoots = @(
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
        "${env:ProgramFiles}\Windows Kits\10\bin"
    ) | Where-Object { $_ -and (Test-Path $_) }

    foreach ($root in $kitRoots) {
        $found = Get-ChildItem -Path $root -Recurse -Filter $Name -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match "x64" } |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($found) { return $found.FullName }
    }

    # Fallback: download the SDK BuildTools NuGet package (no admin / no full SDK).
    $toolsDir = Get-SdkBuildTools
    $candidate = Join-Path $toolsDir $Name
    if (Test-Path $candidate) { return $candidate }

    throw "Could not locate $Name even after fetching Microsoft.Windows.SDK.BuildTools. Install the Windows 10/11 SDK manually."
}

# --- 1. PyInstaller build -----------------------------------------------
if ($WebOnly) {
    # Fast path for web-UI-only changes: skip the (slow) PyInstaller bundle
    # rebuild entirely. Just rebuild web/dist and refresh it inside the
    # existing bundle, then re-pack + re-sign.
    if (-not (Test-Path $DistDir)) {
        throw "Bundle not found at $DistDir. Run a full build at least once before using -WebOnly."
    }

    Write-Host "==> [WebOnly] Building web UI (npm run build)..." -ForegroundColor Cyan
    Push-Location $RepoRoot
    try {
        npm --prefix web run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)." }
    } finally {
        Pop-Location
    }

    $webSrc  = Join-Path $RepoRoot "web\dist"
    $webDest = Join-Path $DistDir "_internal\web\dist"
    if (-not (Test-Path (Join-Path $webSrc "index.html"))) {
        throw "web\dist\index.html not found after build."
    }
    Write-Host "==> [WebOnly] Refreshing web UI in bundle ($webDest)..." -ForegroundColor Cyan
    if (Test-Path $webDest) { Remove-Item $webDest -Recurse -Force }
    New-Item -ItemType Directory -Path $webDest -Force | Out-Null
    Copy-Item -Path (Join-Path $webSrc "*") -Destination $webDest -Recurse -Force
}
elseif (-not $SkipBuild) {
    Write-Host "==> Running PyInstaller..." -ForegroundColor Cyan
    $pyinstallerExe = if (Test-Path $VenvPyInstaller) { $VenvPyInstaller } else { "pyinstaller" }
    & $pyinstallerExe $SpecFile --clean --noconfirm
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller build failed (exit $LASTEXITCODE)." }
}

if (-not (Test-Path $DistDir)) {
    throw "Bundle not found at $DistDir. Run without -SkipBuild or build first."
}

# --- 2. Stage -----------------------------------------------------------
Write-Host "==> Staging package contents..." -ForegroundColor Cyan
if (Test-Path $StagingDir) { Remove-Item $StagingDir -Recurse -Force }
New-Item -ItemType Directory -Path $StagingDir | Out-Null

Copy-Item -Path (Join-Path $DistDir "*") -Destination $StagingDir -Recurse -Force
Copy-Item -Path $AssetsDir -Destination (Join-Path $StagingDir "Assets") -Recurse -Force

# --- 3. Patch manifest identity -----------------------------------------
Write-Host "==> Patching manifest identity..." -ForegroundColor Cyan
[xml]$manifest = Get-Content -Path $ManifestSrc -Raw

$identityNode = $manifest.Package.Identity
$identityNode.Name      = $IdentityName
$identityNode.Publisher = $Publisher
$identityNode.Version   = $Version

$manifest.Package.Properties.PublisherDisplayName = $PublisherDisplayName

$manifestOut = Join-Path $StagingDir "AppxManifest.xml"
$manifest.Save($manifestOut)

# --- 4. Pack ------------------------------------------------------------
Write-Host "==> Packing MSIX..." -ForegroundColor Cyan
$makeappx = Find-WindowsKitTool -Name "makeappx.exe"
if (Test-Path $OutputMsix) { Remove-Item $OutputMsix -Force }

& $makeappx pack /d $StagingDir /p $OutputMsix /overwrite
if ($LASTEXITCODE -ne 0) { throw "makeappx failed (exit $LASTEXITCODE)." }
Write-Host "    Created $OutputMsix" -ForegroundColor Green

# --- 5. Sign (optional) -------------------------------------------------
if ($CertThumbprint) {
    # DigiCert KeyLocker (cloud HSM): the private key stays in the HSM and
    # signtool references the certificate in the store by thumbprint. The
    # KeyLocker KSP handles the actual signing operation transparently.
    Write-Host "==> Signing MSIX (KeyLocker / thumbprint)..." -ForegroundColor Cyan
    $signtool = Find-WindowsKitTool -Name "signtool.exe"

    $signArgs = @(
        "sign",
        "/sha1", $CertThumbprint,
        "/fd", "sha256",
        "/tr", $TimestampUrl,
        "/td", "sha256",
        $OutputMsix
    )

    & $signtool @signArgs
    if ($LASTEXITCODE -ne 0) { throw "signtool failed (exit $LASTEXITCODE)." }
    Write-Host "    Signed $OutputMsix" -ForegroundColor Green
} elseif ($CertPath) {
    if (-not (Test-Path $CertPath)) { throw "Certificate not found: $CertPath" }
    Write-Host "==> Signing MSIX (.pfx)..." -ForegroundColor Cyan
    $signtool = Find-WindowsKitTool -Name "signtool.exe"

    $signArgs = @("sign", "/fd", "SHA256", "/a", "/f", $CertPath)
    if ($CertPassword) { $signArgs += @("/p", $CertPassword) }
    $signArgs += @("/tr", $TimestampUrl, "/td", "sha256", $OutputMsix)

    & $signtool @signArgs
    if ($LASTEXITCODE -ne 0) { throw "signtool failed (exit $LASTEXITCODE)." }
    Write-Host "    Signed $OutputMsix" -ForegroundColor Green
} else {
    Write-Host "==> Skipping signing (no -CertThumbprint or -CertPath supplied)." -ForegroundColor Yellow
    Write-Host "    The package is unsigned and will not install without a trusted signature." -ForegroundColor Yellow
}

Write-Host "Done." -ForegroundColor Green
