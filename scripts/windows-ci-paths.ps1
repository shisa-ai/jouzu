$ErrorActionPreference = "Stop"
if (-not $env:RUNNER_TEMP -or -not $env:GITHUB_ENV) { throw "RUNNER_TEMP and GITHUB_ENV are required" }
$base = $env:RUNNER_TEMP
if ($env:JOUZU_CI_FIXTURE_DRIVE -and $env:JOUZU_CI_FIXTURE_DRIVE -ne "runner") {
    if ($env:JOUZU_CI_FIXTURE_DRIVE -notin @("C", "D")) { throw "Fixture drive must be runner, C, or D" }
    $volume = $env:JOUZU_CI_FIXTURE_DRIVE + ':\'
    if (-not (Test-Path -LiteralPath $volume)) { throw "Fixture volume is unavailable" }
    $base = Join-Path $volume ("jouzu-ci-" + $env:GITHUB_RUN_ID + '-' + $env:GITHUB_JOB)
}
$fixtures = Join-Path $base "jouzu-fixtures"
$cache = Join-Path $env:RUNNER_TEMP "jouzu-npm-cache"
$logs = Join-Path $env:RUNNER_TEMP "jouzu-npm-logs"
New-Item -ItemType Directory -Force -Path $fixtures, $cache, $logs | Out-Null
@("TEMP=$fixtures", "TMP=$fixtures", "JOUZU_CI_FIXTURES=$fixtures",
  "npm_config_cache=$cache", "npm_config_logs_dir=$logs", "npm_config_timing=true",
  "npm_config_logs_max=1000") | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
if ($env:JOUZU_CI_NPM_CACHE -ne "cold") {
    "JOUZU_TEST_NPM_CACHE=$cache" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
}
[ordered]@{ fixtures = $fixtures; cache = $cache; logs = $logs; cacheMode = $env:JOUZU_CI_NPM_CACHE } |
    ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $logs "paths.json")
