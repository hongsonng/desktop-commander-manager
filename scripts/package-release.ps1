# PowerShell script to package Desktop Commander Manager for standalone distribution on Windows
param (
    [string]$Version = "0.1.0"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Packaging Desktop Commander Manager (Windows x64) v$Version" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# 1. Build frontend dashboard
Write-Host "`n[1/4] Building dashboard..." -ForegroundColor Yellow
npm run build -w apps/dashboard

# 2. Build release binary
Write-Host "`n[2/4] Building Rust release binary..." -ForegroundColor Yellow
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
cargo build --workspace --release

# 3. Create staging directory
$DistRoot = Join-Path $RepoRoot "dist-release"
$StageDir = Join-Path $DistRoot "desktop-commander-manager-windows-x64"
if (Test-Path $StageDir) { Remove-Item -Recurse -Force $StageDir }
New-Item -ItemType Directory -Path $StageDir -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $StageDir "data\workers") -Force | Out-Null

Write-Host "`n[3/4] Copying artifacts to staging..." -ForegroundColor Yellow
Copy-Item (Join-Path $RepoRoot "target\release\dcm-manager.exe") -Destination $StageDir
Copy-Item (Join-Path $RepoRoot "apps\dashboard\dist") -Destination (Join-Path $StageDir "dashboard") -Recurse

# Create start.bat
$StartBat = @"
@echo off
setlocal
cd /d "%~dp0"
set DCM_DASHBOARD_DIR=%~dp0dashboard
set DCM_DATABASE_PATH=%~dp0data\manager.db
set DCM_RUNTIME_ROOT=%~dp0data\workers

echo ========================================
echo Desktop Commander Manager
echo MCP URL: http://127.0.0.1:8787/mcp
echo Dashboard: http://127.0.0.1:8788/
echo ========================================
"%~dp0dcm-manager.exe" sidecar
pause
"@
Set-Content -Path (Join-Path $StageDir "start.bat") -Value $StartBat -Encoding ASCII

# Create README.txt
$Readme = @"
Desktop Commander Manager (Standalone Distribution)
Version: $Version

QUICK START:
1. Double click start.bat to launch Desktop Commander Manager.
2. Open your browser and navigate to: http://127.0.0.1:8788/
3. Configure your AI agent / Claude Desktop with MCP URL: http://127.0.0.1:8787/mcp

No source code or Rust toolchain required on this machine!
"@
Set-Content -Path (Join-Path $StageDir "README.txt") -Value $Readme -Encoding UTF8

# 4. Archive into ZIP
Write-Host "`n[4/4] Creating ZIP package..." -ForegroundColor Yellow
$ZipPath = Join-Path $DistRoot "desktop-commander-manager-windows-x64.zip"
if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }
Compress-Archive -Path "$StageDir\*" -DestinationPath $ZipPath -Force

$ZipSize = (Get-Item $ZipPath).Length / 1MB
Write-Host "`n========================================" -ForegroundColor Green
Write-Host "PACKAGE READY: $ZipPath" -ForegroundColor Green
Write-Host "Size: $([math]::Round($ZipSize, 2)) MB" -ForegroundColor Green
Write-Host "Users can download this ZIP, extract, and double-click start.bat directly!" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
