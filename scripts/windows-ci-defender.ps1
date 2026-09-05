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
    $record.effectiveCurrent = @(Get-Exclusions)
    foreach ($path in $record.added) {
        if ($record.effectiveCurrent -contains $path) { $failures += "Exclusion remains: $path" }
    }
    $record.defenderAfter = Get-MpComputerStatus | Select-Object AMRunningMode, AntivirusEnabled, RealTimeProtectionEnabled
    if (-not $record.defenderAfter.RealTimeProtectionEnabled) { $failures += "Defender real-time protection is disabled" }
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
if (-not $defender.RealTimeProtectionEnabled) { throw "Defender real-time protection must be enabled" }
if ($Mode -eq "scanned") {
    Write-Record ([ordered]@{
        schemaVersion = 1
        requested = @()
        added = @()
        effectiveBefore = @(Get-Exclusions)
        effectiveCurrent = @(Get-Exclusions)
        defenderBefore = $defender
        defenderAfter = $null
        cleanupStatus = "pending"
    })
    return
}
$cacheOutput = & npm.cmd config get cache
if ($LASTEXITCODE -ne 0) { throw "npm cache lookup failed" }
$prefixOutput = & npm.cmd prefix --global
if ($LASTEXITCODE -ne 0) { throw "npm global prefix lookup failed" }
$cache = Full-Path ($cacheOutput | Out-String).Trim()
$fixtures = Full-Path (Join-Path $env:RUNNER_TEMP "jouzu-fixtures")
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
