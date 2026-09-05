$ErrorActionPreference = "Stop"
$target = Join-Path $PSScriptRoot "windows-ci-defender.ps1"
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("jouzu-defender-test-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $testRoot | Out-Null
$saved = @{}
foreach ($name in @("RUNNER_TEMP", "GITHUB_WORKSPACE", "GITHUB_ENV", "JOUZU_CI_FIXTURES")) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name)
}
if (Get-Variable jouzuDefenderTest -Scope Global -ErrorAction SilentlyContinue) { throw "Defender test is already running" }
$global:jouzuDefenderTest = @{}
$global:jouzuDefenderTest.excluded = @()
$global:jouzuDefenderTest.addFailure = $null
$global:jouzuDefenderTest.removeFailure = $null
$global:jouzuDefenderTest.protection = $true
$global:jouzuDefenderTest.cache = Join-Path $testRoot "npm-cache"
$global:jouzuDefenderTest.prefix = Join-Path $testRoot "global-prefix"

function Get-MpComputerStatus {
    return [pscustomobject]@{ AMRunningMode = "Normal"; AntivirusEnabled = $true; RealTimeProtectionEnabled = $global:jouzuDefenderTest.protection }
}
function Get-MpPreference { return [pscustomobject]@{ ExclusionPath = @($global:jouzuDefenderTest.excluded) } }
function Add-MpPreference([string]$ExclusionPath) {
    if ($ExclusionPath -eq $global:jouzuDefenderTest.addFailure) { throw "injected add failure" }
    $global:jouzuDefenderTest.excluded += $ExclusionPath
}
function Remove-MpPreference([string]$ExclusionPath) {
    if ($ExclusionPath -eq $global:jouzuDefenderTest.removeFailure) { throw "injected remove failure" }
    $global:jouzuDefenderTest.excluded = @($global:jouzuDefenderTest.excluded | Where-Object { $_ -ne $ExclusionPath })
}
function npm.cmd {
    $global:LASTEXITCODE = 0
    if ($args[0] -eq "config") { return $global:jouzuDefenderTest.cache }
    return $global:jouzuDefenderTest.prefix
}
function Assert-True($Value, [string]$Message) { if (-not $Value) { throw $Message } }
function Assert-Fails([scriptblock]$Action, [string]$Pattern) {
    $failure = $null
    try { & $Action } catch { $failure = $_.Exception.Message }
    Assert-True ($failure -match $Pattern) "Expected failure matching '$Pattern', got '$failure'"
}
function New-Case {
    $env:JOUZU_CI_FIXTURES = $null
    $env:RUNNER_TEMP = Join-Path $testRoot ([guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $env:RUNNER_TEMP | Out-Null
    $env:GITHUB_WORKSPACE = Join-Path $testRoot "checkout"
    $env:GITHUB_ENV = Join-Path $env:RUNNER_TEMP "environment"
    $global:jouzuDefenderTest.cache = Join-Path $testRoot "npm-cache"
    $global:jouzuDefenderTest.excluded = @()
    $global:jouzuDefenderTest.addFailure = $null
    $global:jouzuDefenderTest.removeFailure = $null
    $global:jouzuDefenderTest.protection = $true
}
function Read-Record { return Get-Content -Raw (Join-Path $env:RUNNER_TEMP "jouzu-defender.json") | ConvertFrom-Json }

try {
    New-Case
    & $target scanned
    Assert-True ($global:jouzuDefenderTest.excluded.Count -eq 0) "Scanned mode added exclusions"
    Assert-True (-not (Test-Path $env:GITHUB_ENV)) "Scanned mode changed fixture locations"
    & $target cleanup

    New-Case
    $global:jouzuDefenderTest.excluded = @($global:jouzuDefenderTest.cache, (Join-Path $testRoot "preexisting"))
    & $target setup
    Assert-True ((Read-Record).added.Count -eq 1) "Setup must preserve existing exclusions"
    Assert-True ((Get-Content -Raw $env:GITHUB_ENV) -match 'TEMP=.*jouzu-fixtures') "Fixture temp was not exported"
    & $target cleanup
    & $target cleanup
    Assert-True ($global:jouzuDefenderTest.excluded.Count -eq 2) "Cleanup removed an existing exclusion"
    Assert-True ((Read-Record).cleanupStatus -eq "passed") "Cleanup did not pass"

    New-Case
    $global:jouzuDefenderTest.addFailure = Join-Path $env:RUNNER_TEMP "jouzu-fixtures"
    Assert-Fails { & $target setup } 'injected add failure'
    & $target cleanup
    Assert-True ($global:jouzuDefenderTest.excluded.Count -eq 0) "Partial setup leaked an exclusion"

    New-Case
    & $target setup
    $global:jouzuDefenderTest.removeFailure = $global:jouzuDefenderTest.cache
    Assert-Fails { & $target cleanup } 'injected remove failure'
    Assert-True ($global:jouzuDefenderTest.excluded.Count -eq 1) "Cleanup stopped before removing the other exclusion"
    Assert-True ((Read-Record).cleanupStatus -eq "failed") "Cleanup failure was not recorded"
    $global:jouzuDefenderTest.removeFailure = $null
    & $target cleanup

    foreach ($unsafe in @([IO.Path]::GetPathRoot($testRoot), $env:USERPROFILE, $global:jouzuDefenderTest.prefix, (Join-Path $testRoot "checkout"), (Join-Path $testRoot "checkout\cache"), (Join-Path $global:jouzuDefenderTest.prefix "cache"), $testRoot, 'relative-cache', 'C:\cache\*')) {
        New-Case
        $global:jouzuDefenderTest.cache = $unsafe
        Assert-Fails { & $target setup } 'Cannot exclude|protected directory|absolute path without wildcards'
        Assert-True ($global:jouzuDefenderTest.excluded.Count -eq 0) "Unsafe setup mutated exclusions"
    }

    New-Case
    $global:jouzuDefenderTest.protection = $false
    $global:jouzuDefenderTest.excluded = @('C:\', 'D:\')
    & $target setup
    Assert-True ((Read-Record).configuration -eq "image-protection-disabled") "Image protection state was not recorded"
    Assert-True (-not (Test-Path $env:GITHUB_ENV)) "Disabled image protection changed fixture locations"
    & $target cleanup
    Assert-True ($global:jouzuDefenderTest.excluded.Count -eq 2) "Image exclusions were changed"
    Assert-True (-not $global:jouzuDefenderTest.protection) "Image protection was changed"

    New-Case
    & $target setup
    $global:jouzuDefenderTest.protection = $false
    Assert-Fails { & $target cleanup } 'disabled during the job'
    Assert-True ($global:jouzuDefenderTest.excluded.Count -eq 0) "Protection failure leaked exclusions"
    Write-Host "Windows Defender setup, cleanup, failure recovery, and path-boundary tests passed"
}
finally {
    foreach ($entry in $saved.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value)
    }
    Remove-Variable jouzuDefenderTest -Scope Global
    Remove-Item -LiteralPath $testRoot -Recurse -Force
}
