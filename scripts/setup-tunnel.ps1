param(
    [string]$TunnelId,
    [string]$ProfileName = 'desktop-commander-manager',
    [string]$McpServerUrl = 'http://127.0.0.1:8787/mcp'
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

function Write-Step([string]$Message) {
    Write-Host "[*] $Message" -ForegroundColor Cyan
}

function Test-ManagerHealthy {
    try {
        $result = Invoke-RestMethod -Uri 'http://127.0.0.1:8788/api/health' -TimeoutSec 2
        return $result.status -eq 'ok'
    } catch {
        return $false
    }
}

function Ensure-TunnelClient {
    Write-Step 'Checking tunnel-client...'
    $cmd = Get-Command tunnel-client -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd
    }

    $candidateDir = Join-Path $env:LOCALAPPDATA 'Programs\OpenAI\tunnel-client'
    $candidate = Join-Path $candidateDir 'tunnel-client.exe'
    if (Test-Path $candidate) {
        $env:Path = "$env:Path;$candidateDir"
        return (Get-Item $candidate)
    }

    Write-Host 'tunnel-client is not installed. Attempting automatic download from OpenAI...' -ForegroundColor Cyan
    try {
        New-Item -ItemType Directory -Force -Path $candidateDir | Out-Null
        $zipFile = Join-Path $env:TEMP "tunnel-client-windows-$PID.zip"

        $downloadUrl = $null
        try {
            $latest = Invoke-RestMethod -Uri 'https://api.github.com/repos/openai/tunnel-client/releases/latest' -TimeoutSec 10 -UseBasicParsing
            $asset = $latest.assets | Where-Object { $_.name -like 'tunnel-client-*-windows-amd64.zip' -and $_.name -notlike '*runtime*' } | Select-Object -First 1
            if ($asset -and $asset.browser_download_url) {
                $downloadUrl = $asset.browser_download_url
            }
        } catch {
            # Fallback if GitHub API is unreachable or rate limited
        }

        if (-not $downloadUrl) {
            $downloadUrl = 'https://github.com/openai/tunnel-client/releases/download/v0.0.16/tunnel-client-v0.0.16-windows-amd64.zip'
        }

        Write-Host "Downloading $downloadUrl..." -ForegroundColor Cyan
        Invoke-WebRequest -Uri $downloadUrl -OutFile $zipFile -UseBasicParsing

        Write-Host "Extracting to $candidateDir..." -ForegroundColor Cyan
        Expand-Archive -Path $zipFile -DestinationPath $candidateDir -Force
        Remove-Item $zipFile -Force -ErrorAction SilentlyContinue

        if (Test-Path $candidate) {
            $env:Path = "$env:Path;$candidateDir"
            Write-Host 'tunnel-client installed successfully.' -ForegroundColor Green
            return (Get-Item $candidate)
        }
    } catch {
        Write-Warning "Automatic download failed: $($_.Exception.Message)"
    }

    throw 'tunnel-client is not installed and could not be downloaded automatically. Install the official OpenAI tunnel-client first.'
}

$tunnelCommand = Ensure-TunnelClient

if (-not $TunnelId) {
    Write-Host 'Create or inspect the tunnel here:' -ForegroundColor Yellow
    Write-Host 'https://platform.openai.com/settings/organization/tunnels'
    $TunnelId = (Read-Host 'Tunnel ID').Trim()
}
if ($TunnelId -notmatch '^tunnel_[0-9a-f]{32}$') {
    throw 'Tunnel ID must match tunnel_<32 lowercase hexadecimal characters>.'
}

Write-Step 'Reading runtime API key securely...'
Write-Host 'Create a Restricted runtime key with Tunnels Read + Use:' -ForegroundColor Yellow
Write-Host 'https://platform.openai.com/settings/organization/api-keys'
$secureKey = Read-Host 'Runtime API key (input hidden)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
$plainKey = $null

$ProfileDir = Join-Path $env:APPDATA 'tunnel-client'
$SecretDir = Join-Path $ProfileDir 'secrets'
$SecretPath = Join-Path $SecretDir "$ProfileName.api-key"
$ProfilePath = Join-Path $ProfileDir "$ProfileName.yaml"

try {
    $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if ([string]::IsNullOrWhiteSpace($plainKey)) {
        throw 'Runtime API key cannot be empty.'
    }

    New-Item -ItemType Directory -Path $SecretDir -Force | Out-Null
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($SecretPath, $plainKey.Trim(), $utf8NoBom)
} finally {
    if ($bstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    $plainKey = $null
}

Write-Step 'Restricting runtime key file to the current Windows user...'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
& $icacls $SecretPath /inheritance:r /grant:r "${identity}:(R,W)" | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Could not restrict permissions on $SecretPath"
}

$secretRef = 'file:' + ($SecretPath -replace '\\', '/')
Write-Step 'Creating tunnel-client profile...'
& $tunnelCommand.Source init --force --sample sample_mcp_remote_no_auth --profile $ProfileName --tunnel-id $TunnelId --mcp-server-url $McpServerUrl --control-plane-api-key-ref $secretRef
if ($LASTEXITCODE -ne 0) {
    throw 'tunnel-client init failed.'
}

if (-not (Test-ManagerHealthy)) {
    Write-Step 'Manager is not healthy; starting headless runner...'
    $managerRunner = Join-Path $RepoRoot 'scripts\run-manager-headless.ps1'
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $managerRunner
    ) | Out-Null

    for ($i = 0; $i -lt 20 -and -not (Test-ManagerHealthy); $i++) {
        Start-Sleep -Seconds 1
    }
}
if (-not (Test-ManagerHealthy)) {
    throw 'Desktop Commander Manager is not healthy on http://127.0.0.1:8788.'
}

Write-Step 'Validating tunnel profile with doctor...'
& $tunnelCommand.Source doctor --profile $ProfileName --explain
if ($LASTEXITCODE -ne 0) {
    Write-Host "Profile was created at $ProfilePath, but doctor did not pass." -ForegroundColor Yellow
    Write-Host 'Fix the tunnel association/permissions, then rerun setup-tunnel.bat.'
    exit 2
}

Write-Step 'Registering manager and tunnel autostart...'
$env:ComSpec = "$env:SystemRoot\System32\cmd.exe"
$env:COMSPEC = $env:ComSpec
& npm.cmd run autostart:install
if ($LASTEXITCODE -ne 0) {
    throw 'Autostart installation failed.'
}

Write-Host ''
Write-Host 'Secure MCP Tunnel setup completed.' -ForegroundColor Green
Write-Host "Profile: $ProfilePath"
Write-Host "MCP target: $McpServerUrl"
Write-Host 'Next: ChatGPT Plugins -> Create custom MCP server -> Connection: Tunnel -> choose this tunnel.'
Write-Host 'https://chatgpt.com/#settings/Connectors'
