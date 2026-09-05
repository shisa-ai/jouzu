$ErrorActionPreference = "Stop"
$root = Join-Path ([IO.Path]::GetTempPath()) ("jouzu-paths-test-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $root | Out-Null
$saved = @{}
foreach ($name in @("RUNNER_TEMP", "GITHUB_ENV", "JOUZU_CI_FIXTURE_DRIVE", "JOUZU_CI_NPM_CACHE")) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name)
}
try {
    $env:RUNNER_TEMP = $root
    $env:JOUZU_CI_FIXTURE_DRIVE = "runner"
    foreach ($mode in @("warm", "cold")) {
        $env:JOUZU_CI_NPM_CACHE = $mode
        $env:GITHUB_ENV = Join-Path $root ($mode + '.env')
        & (Join-Path $PSScriptRoot "windows-ci-paths.ps1")
        $exports = Get-Content -Raw $env:GITHUB_ENV
        if ($exports -notmatch 'TEMP=.*jouzu-fixtures' -or $exports -notmatch 'npm_config_logs_dir=') { throw "Fixture/log paths were not exported" }
        if (($exports -match 'JOUZU_TEST_NPM_CACHE=') -ne ($mode -eq "warm")) { throw "Updater cache mode mismatch" }
        $record = Get-Content -Raw (Join-Path $root "jouzu-npm-logs/paths.json") | ConvertFrom-Json
        if (-not (Test-Path -LiteralPath $record.fixtures)) { throw "Fixture directory is missing" }
    }
    $env:JOUZU_CI_FIXTURE_DRIVE = "Z"
    $failed = $false
    try { & (Join-Path $PSScriptRoot "windows-ci-paths.ps1") } catch { $failed = $true }
    if (-not $failed) { throw "Invalid drive was accepted" }
    Write-Host "Windows fixture and cache path tests passed"
} finally {
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
    Remove-Item -LiteralPath $root -Recurse -Force
}
