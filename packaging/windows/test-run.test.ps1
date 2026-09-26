param([string]$AcceptanceScript = (Join-Path $PSScriptRoot 'test.ps1'))
$ErrorActionPreference = 'Stop'
# Load only Run so these checks do not install a payload or require a standard account.
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($AcceptanceScript, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Acceptance script has parse errors' }
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Run' }, $true)
if (-not $function) { throw 'Acceptance script has no Run helper' }
. ([scriptblock]::Create($function.Extent.Text))
$root = Join-Path ([IO.Path]::GetTempPath()) ('jouzu-native-run-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $root | Out-Null
try {
    $fixture = Join-Path $root 'native fixture.ps1'
    [IO.File]::WriteAllText($fixture, 'param([int]$Code) [Console]::Out.WriteLine("fixture stdout"); [Console]::Error.WriteLine("fixture stderr"); exit $Code')
    $shell = Join-Path $PSHOME 'powershell.exe'
    $text = Run $shell @('-NoProfile','-File',$fixture,'0')
    if ($text -notmatch 'fixture stdout' -or $text -notmatch 'fixture stderr') { throw 'Run lost native output' }
    if ($ErrorActionPreference -ne 'Stop') { throw 'Run changed the caller error preference' }
    $failure = ''
    try { $null = Run $shell @('-NoProfile','-File',$fixture,'7') } catch { $failure = $_.Exception.Message }
    if ($failure -notmatch 'exited 7' -or $failure -notmatch 'fixture stderr') { throw "Run lost failure diagnostics: $failure" }
    if ($ErrorActionPreference -ne 'Stop') { throw 'Failed Run changed the caller error preference' }
    $missing = $false
    try { $null = Run (Join-Path $root 'missing.exe') @() } catch { $missing = $true }
    if (-not $missing) { throw 'Run accepted a missing executable' }
    $invalid = Join-Path $root 'invalid.exe'
    [IO.File]::WriteAllText($invalid, 'This is not an executable.')
    $rejected = $false
    try { $null = Run $invalid @() } catch { $rejected = $true }
    if (-not $rejected) { throw 'Run accepted an executable that could not start' }
    if ($ErrorActionPreference -ne 'Stop') { throw 'Launch failure changed the caller error preference' }
    Write-Output 'Native command success, stderr, failure, launch failure, and preference checks passed'
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
