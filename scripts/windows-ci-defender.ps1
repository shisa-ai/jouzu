param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("setup", "scanned", "cleanup")]
    [string]$Mode
)

$ErrorActionPreference = "Stop"
if (-not $env:RUNNER_TEMP) { throw "RUNNER_TEMP is required" }
$statePath = Join-Path $env:RUNNER_TEMP "jouzu-defender.json"

function Get-Exclusions {
    return @((Get-MpPreference).ExclusionPath | Where-Object { $_ })
}

function Write-Record($Record) {
    $Record | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $statePath
}

function Full-Path([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { throw "An exclusion path is empty" }
    if (-not [IO.Path]::IsPathRooted($Path) -or $Path.IndexOfAny([char[]]'*?') -ge 0) {
        throw "An exclusion must be an absolute path without wildcards"
    }
    return [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Contains-Path([string]$Parent, [string]$Child) {
    return $Child.Equals($Parent, [StringComparison]::OrdinalIgnoreCase) -or
        $Child.StartsWith($Parent + '\', [StringComparison]::OrdinalIgnoreCase)
}

if ($Mode -eq "cleanup") {
    if (-not (Test-Path -LiteralPath $statePath)) { return }
    $record = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    $failures = @()
    foreach ($path in $record.added) {
        try {
            if ((Get-Exclusions) -contains $path) { Remove-MpPreference -ExclusionPath $path }
        }
        catch { $failures += $_.Exception.Message }
    }
    try {
        $record.effectiveCurrent = @(Get-Exclusions)
        $record.defenderAfter = Get-MpComputerStatus | Select-Object AMRunningMode, AntivirusEnabled, RealTimeProtectionEnabled
    }
    catch {
        $record.effectiveCurrent = $null
        $record.defenderAfter = $null
        $record | Add-Member -NotePropertyName inspectionError -NotePropertyValue $_.Exception.Message -Force
        # A disabled image service can stop answering after setup. With no
        # job-added exclusions there is no cleanup mutation to perform.
        if (@($record.added).Count -eq 0 -and -not $record.defenderBefore.RealTimeProtectionEnabled -and
            $_.Exception.Message -match '0x800106ba') {
            $record.cleanupStatus = "not-required"
            Write-Record $record
            Get-Content -Raw -LiteralPath $statePath | Write-Host
            return
        }
        $record.cleanupStatus = "failed"
        Write-Record $record
        throw
    }
    foreach ($path in $record.added) {
        if ($record.effectiveCurrent -contains $path) { $failures += "Exclusion remains: $path" }
    }
    if ($record.defenderBefore.RealTimeProtectionEnabled -and -not $record.defenderAfter.RealTimeProtectionEnabled) {
        $failures += "Defender real-time protection was disabled during the job"
    }
    $record.cleanupStatus = if ($failures.Count) { "failed" } else { "passed" }
    Write-Record $record
    Get-Content -Raw -LiteralPath $statePath | Write-Host
    if ($failures.Count) { throw ($failures -join '; ') }
    return
}

if (Test-Path -LiteralPath $statePath) { throw "Defender setup already has a state record" }
if (-not $env:GITHUB_ENV -or -not $env:GITHUB_WORKSPACE -or -not $env:USERPROFILE) {
    throw "GITHUB_ENV, GITHUB_WORKSPACE, and USERPROFILE are required"
}
$defender = Get-MpComputerStatus | Select-Object AMRunningMode, AntivirusEnabled, RealTimeProtectionEnabled
if ($Mode -eq "scanned" -or -not $defender.RealTimeProtectionEnabled) {
    Write-Record ([ordered]@{
        schemaVersion = 1
        configuration = if ($defender.RealTimeProtectionEnabled) { "image-exclusions" } else { "image-protection-disabled" }
        requested = @()
        added = @()
        effectiveBefore = @(Get-Exclusions)
        effectiveCurrent = @(Get-Exclusions)
        defenderBefore = $defender
        defenderAfter = $null
        cleanupStatus = "pending"
    })
    Get-Content -Raw -LiteralPath $statePath | Write-Host
    return
}
$cacheOutput = & npm.cmd config get cache
if ($LASTEXITCODE -ne 0) { throw "npm cache lookup failed" }
$prefixOutput = & npm.cmd prefix --global
if ($LASTEXITCODE -ne 0) { throw "npm global prefix lookup failed" }
$cache = Full-Path ($cacheOutput | Out-String).Trim()
$fixtures = if ($env:JOUZU_CI_FIXTURES) { Full-Path $env:JOUZU_CI_FIXTURES } else { Full-Path (Join-Path $env:RUNNER_TEMP "jouzu-fixtures") }
$protected = @($env:GITHUB_WORKSPACE, $env:USERPROFILE, ($prefixOutput | Out-String).Trim()) |
    ForEach-Object { Full-Path $_ }
$requested = @($cache, $fixtures) | Select-Object -Unique
foreach ($path in $requested) {
    if ($path -eq (Full-Path ([IO.Path]::GetPathRoot($path)))) { throw "Cannot exclude a volume root" }
    foreach ($protectedPath in $protected) {
        if (Contains-Path $path $protectedPath) { throw "Exclusion includes a protected directory: $path" }
    }
    foreach ($protectedPath in @($protected[0], $protected[2])) {
        if (Contains-Path $protectedPath $path) { throw "Exclusion is inside a protected directory: $path" }
    }
}
New-Item -ItemType Directory -Force -Path $fixtures, $cache | Out-Null
$record = [ordered]@{
    schemaVersion = 1
    configuration = "scoped-exclusions"
    requested = @($requested)
    added = @()
    effectiveBefore = @(Get-Exclusions)
    effectiveCurrent = @(Get-Exclusions)
    defenderBefore = $defender
    defenderAfter = $null
    cleanupStatus = "pending"
}
Write-Record $record
foreach ($path in $requested) {
    if ((Get-Exclusions) -notcontains $path) {
        # Persist intent before mutation so cleanup also handles interrupted setup.
        $record.added += $path
        Write-Record $record
        Add-MpPreference -ExclusionPath $path
    }
}
$record.effectiveCurrent = @(Get-Exclusions)
Write-Record $record
foreach ($path in $requested) {
    if ($record.effectiveCurrent -notcontains $path) { throw "Exclusion was not applied: $path" }
}
@("TEMP=$fixtures", "TMP=$fixtures") | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
Get-Content -Raw -LiteralPath $statePath | Write-Host
