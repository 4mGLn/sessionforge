# Installs the standalone sessionforge CLI binary — no Node.js required on this machine, unlike
# `npm install -g sessionforge-cli`. Downloads the prebuilt Windows binary from the latest GitHub Release
# and places it on your user PATH.
#
# Usage:
#   irm https://raw.githubusercontent.com/4mGLn/sessionforge/main/install.ps1 | iex
#
# Override install location with $env:SESSIONFORGE_INSTALL_DIR (default: %USERPROFILE%\.sessionforge\bin).

$ErrorActionPreference = "Stop"

$Repo = "4mGLn/sessionforge"
$InstallDir = if ($env:SESSIONFORGE_INSTALL_DIR) { $env:SESSIONFORGE_INSTALL_DIR } else { Join-Path $env:USERPROFILE ".sessionforge\bin" }

if (-not [Environment]::Is64BitOperatingSystem) {
    Write-Error "sessionforge: only 64-bit Windows builds are published (x86_64-pc-windows-msvc)."
    exit 1
}

$Target = "x86_64-pc-windows-msvc"
$Asset = "sessionforge-$Target.exe"
$Url = "https://github.com/$Repo/releases/latest/download/$Asset"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$Dest = Join-Path $InstallDir "sessionforge.exe"

Write-Host "sessionforge: downloading $Asset..."
try {
    Invoke-WebRequest -Uri $Url -OutFile $Dest
} catch {
    Write-Error "sessionforge: download failed - is there a published release yet? https://github.com/$Repo/releases"
    exit 1
}

Write-Host "sessionforge: installed to $Dest"

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    Write-Host ""
    Write-Host "Added $InstallDir to your user PATH. Restart your terminal for it to take effect."
}

Write-Host ""
Write-Host "Run 'sessionforge --help' to get started (in a new terminal, if PATH was just updated)."
