$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$env:ComSpec = "$env:SystemRoot\System32\cmd.exe"
$env:COMSPEC = $env:ComSpec

$LogDir = Join-Path $RepoRoot 'data\logs'
$LogPath = Join-Path $LogDir 'manager-autostart.log'
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

function Write-ManagerLog([string]$Message) {
    Add-Content -Path $LogPath -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" -Encoding UTF8
}

function Test-ManagerHealthy {
    try {
        $result = Invoke-RestMethod -Uri 'http://127.0.0.1:8788/api/health' -TimeoutSec 2
        return $result.status -eq 'ok'
    } catch {
        return $false
    }
}

function Test-ManagerPortBusy {
    return $null -ne (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 8787, 8788 } | Select-Object -First 1)
}

if (Test-ManagerHealthy) {
    Write-ManagerLog 'Manager is already healthy; no duplicate instance started.'
    exit 0
}

if (Test-ManagerPortBusy) {
    Write-ManagerLog 'Port 8787 or 8788 is already in use by another process; startup aborted.'
    exit 3
}

if (-not (Test-Path (Join-Path $RepoRoot 'node_modules\.package-lock.json'))) {
    Write-ManagerLog 'Dependencies are missing. Run install-autostart.bat or npm install first.'
    exit 4
}

if (-not (Test-Path (Join-Path $RepoRoot 'apps\dashboard\dist\index.html'))) {
    Write-ManagerLog 'Dashboard build is missing. Run install-autostart.bat or npm run build first.'
    exit 5
}

$attempt = 0
while ($true) {
    $attempt++
    Write-ManagerLog "Starting manager, attempt $attempt."
    & npm.cmd run dev *>> $LogPath
    $exitCode = $LASTEXITCODE

    if (Test-ManagerHealthy) {
        Write-ManagerLog 'Another healthy manager instance is running; stopping restart loop.'
        exit 0
    }

    Write-ManagerLog "Manager exited with code $exitCode; retrying in 5 seconds."
    Start-Sleep -Seconds 5
}
