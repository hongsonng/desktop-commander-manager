$ErrorActionPreference = 'Stop'
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Push-Location $repoRoot
try {
    if (-not $env:ComSpec) { $env:ComSpec = Join-Path $env:SystemRoot 'System32\cmd.exe' }
    $env:COMSPEC = $env:ComSpec
    $tsx = Join-Path $repoRoot 'node_modules\.bin\tsx.cmd'
    if (-not (Test-Path $tsx)) { throw "tsx is not installed. Run npm install first." }
    & $tsx (Join-Path $PSScriptRoot 'smoke-runner.ts')
    if ($LASTEXITCODE -ne 0) { throw "Windows smoke test failed with exit code $LASTEXITCODE" }
}
finally {
    Remove-Item (Join-Path $repoRoot '.superpowers\smoke') -Recurse -Force -ErrorAction SilentlyContinue
    Pop-Location
}
