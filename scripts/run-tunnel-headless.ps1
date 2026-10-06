$ErrorActionPreference = 'Continue'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $RepoRoot 'data\logs'
$LogPath = Join-Path $LogDir 'tunnel-autostart.log'
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

function Write-TunnelLog([string]$Message) {
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

$tunnelCommand = Get-Command tunnel-client -ErrorAction SilentlyContinue
$tunnelExecutable = if ($tunnelCommand) { $tunnelCommand.Source } else { $null }

if (-not $tunnelExecutable) {
    $candidate = Join-Path $env:LOCALAPPDATA 'Programs\OpenAI\tunnel-client\tunnel-client.exe'
    if (Test-Path $candidate) {
        $tunnelExecutable = $candidate
        Write-TunnelLog "tunnel-client resolved from user install path: $candidate"
    }
}

if (-not $tunnelExecutable) {
    Write-TunnelLog 'tunnel-client was not found in PATH or the default user install path; tunnel autostart cannot run.'
    exit 2
}

while (-not (Test-ManagerHealthy)) {
    Write-TunnelLog 'Waiting for Desktop Commander Manager health endpoint.'
    Start-Sleep -Seconds 5
}

while ($true) {
    & $tunnelExecutable doctor --profile desktop-commander-manager --explain *>> $LogPath
    if ($LASTEXITCODE -ne 0) {
        Write-TunnelLog 'Tunnel profile is not ready yet. Retrying in 60 seconds.'
        Start-Sleep -Seconds 60
        continue
    }

    Write-TunnelLog 'Starting OpenAI Secure MCP Tunnel profile desktop-commander-manager.'
    & $tunnelExecutable run --profile desktop-commander-manager *>> $LogPath
    $exitCode = $LASTEXITCODE
    Write-TunnelLog "Tunnel process exited with code $exitCode; retrying in 5 seconds."
    Start-Sleep -Seconds 5
}
