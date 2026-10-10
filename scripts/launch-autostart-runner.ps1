param(
    [Parameter(Mandatory = $true)]
    [string]$Runner
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Runner -PathType Leaf)) {
    throw "Autostart runner was not found: $Runner"
}

$RepoRoot = Split-Path -Parent (Split-Path -Parent $Runner)
$LogDir = Join-Path $RepoRoot 'data\logs'
$LogPath = Join-Path $LogDir 'autostart-bootstrap.log'
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

function Write-BootstrapLog([string]$Message) {
    Add-Content -Path $LogPath -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" -Encoding UTF8
}

$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$launcher = Join-Path $PSScriptRoot 'run-headless.vbs'
$commandLine = "`"$wscript`" //B //Nologo `"$launcher`" `"$Runner`""
$lastError = $null

for ($attempt = 1; $attempt -le 15; $attempt++) {
    try {
        $result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
            CommandLine = $commandLine
        }

        if ($result.ReturnValue -eq 0) {
            Write-BootstrapLog "Started $Runner via Win32_Process.Create (PID=$($result.ProcessId), attempt=$attempt)."
            exit 0
        }

        $lastError = "ReturnValue=$($result.ReturnValue)"
        Write-BootstrapLog "Could not start $Runner via Win32_Process.Create ($lastError, attempt=$attempt/15)."
    } catch {
        $lastError = $_.Exception.Message
        Write-BootstrapLog "CIM launch failed for $Runner (attempt=$attempt/15): $lastError"
    }

    Start-Sleep -Seconds 2
}

throw "Could not launch autostart runner after 15 attempts: $Runner ($lastError)"
