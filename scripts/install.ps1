# Sajimora Windows Native Installer (Zero npm, Zero Node.js)
# Usage: irm https://raw.githubusercontent.com/sajimora/sajimora/main/scripts/install.ps1 | iex

$ErrorActionPreference = 'Stop'

Write-Host "=== Installing Sajimora Native API Gatekeeper ===" -ForegroundColor Cyan

$repo = "sajimoraofficial/sajimora"
$tag = "v0.10.0"

try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -UseBasicParsing -TimeoutSec 3 -ErrorAction SilentlyContinue
    if ($release.tag_name) {
        $tag = $release.tag_name
    }
} catch {
    # Fallback to default version tag if GitHub API rate-limited
}

$installDir = Join-Path $env:LOCALAPPDATA "Programs\Sajimora\bin"
if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
}

$zipName = "sajimora-$tag-x86_64-pc-windows-msvc.zip"
$zipUrl = "https://github.com/$repo/releases/download/$tag/$zipName"
$tempZip = Join-Path $env:TEMP $zipName

Write-Host "[*] Downloading Sajimora $tag for Windows x64..." -ForegroundColor Gray
try {
    Invoke-WebRequest -Uri $zipUrl -OutFile $tempZip -UseBasicParsing -TimeoutSec 15
    Expand-Archive -Path $tempZip -DestinationPath $installDir -Force
    Remove-Item $tempZip -Force
} catch {
    throw "Failed to download $zipUrl. Please check your internet connection or download manually from https://github.com/$repo/releases"
}

$userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
if (-not $userPath) {
    $userPath = ""
}

$pathEntries = $userPath.Split(';')
$alreadyInPath = $false
foreach ($entry in $pathEntries) {
    if ($entry.Trim().ToLower() -eq $installDir.ToLower()) {
        $alreadyInPath = $true
        break
    }
}

if (-not $alreadyInPath) {
    Write-Host "[*] Adding Sajimora to User PATH..." -ForegroundColor Gray
    if ($userPath.Length -gt 0) {
        $newPath = "$userPath;$installDir"
    } else {
        $newPath = $installDir
    }
    [System.Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    $env:Path = "$env:Path;$installDir"
}

Write-Host ""
Write-Host "[OK] Sajimora installed successfully!" -ForegroundColor Green
Write-Host "     Location: $installDir\sajimora.exe"
Write-Host "     Version:  $tag"
Write-Host ""
Write-Host "Quickstart:" -ForegroundColor Yellow
Write-Host "     1. Open a new terminal"
Write-Host "     2. cd to your repository"
Write-Host "     3. Run: sajimora init --apply"
Write-Host ""
