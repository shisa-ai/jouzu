param(
    [Parameter(Mandatory=$true)][string]$Installer,
    [Parameter(Mandatory=$true)][string]$TestDirectory,
    [switch]$KeepInstalled
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ((New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run acceptance with a non-elevated user token'
}
if (Test-Path $TestDirectory) { throw 'TestDirectory must be new' }
New-Item -ItemType Directory $TestDirectory | Out-Null
$install = Join-Path $TestDirectory '日本語 program files'
$project = Join-Path $TestDirectory '日本語 project'
$data = Join-Path $TestDirectory 'user data'
New-Item -ItemType Directory $project | Out-Null
$sentinel = Join-Path $project 'keep.txt'
[IO.File]::WriteAllText($sentinel, 'Project content must survive install and uninstall.')
$original = (Get-FileHash -LiteralPath $sentinel).Hash
$env:JOUZU_HOME = $data
$env:PATH = "$env:WINDIR\System32;$env:WINDIR"
$env:NODE_PATH = ''
$env:NODE_OPTIONS = ''
$results = [ordered]@{ elevated=$false; install=$install; project=$project; data=$data }
function Run([string]$Command, [string[]]$Arguments) {
    $executable = (Get-Command -Name $Command -CommandType Application -ErrorAction Stop).Source
    $previousPreference = $ErrorActionPreference
    try {
        # Windows PowerShell treats redirected native stderr as ErrorRecords.
        # Capture it, but use the process exit code to decide success.
        $ErrorActionPreference = 'Continue'
        $global:LASTEXITCODE = $null
        $text = & $executable @Arguments 2>&1 | Out-String
        $exitCode = $global:LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($null -eq $exitCode) { throw "$Command did not return an exit code : $text" }
    if ($exitCode -ne 0) { throw "$Command exited $exitCode : $text" }
    return $text
}
& (Join-Path $PSScriptRoot 'test-run.test.ps1')
Write-Host 'Checking Windows argument parsing'
$argumentTests = Join-Path $TestDirectory 'LauncherTests.exe'
$null = Run (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe') @(
    '/nologo','/target:exe','/platform:x64','/define:GUI','/main:LauncherTests',('/out:' + $argumentTests),
    '/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll','/reference:System.Windows.Forms.dll',
    '/reference:System.Security.dll','/reference:System.Core.dll',
    (Join-Path $PSScriptRoot 'Jouzu.cs'),(Join-Path $PSScriptRoot 'Updates.cs'),(Join-Path $PSScriptRoot 'Jouzu.test.cs'))
$results.arguments = (Run $argumentTests @()).Trim()
Write-Host 'Installing as a standard user'
$watch = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process $Installer -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/DIR="' + $install + '"'),('/LOG="' + (Join-Path $TestDirectory 'install.log') + '"')) -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "Installer exited $($p.ExitCode)" }
$results.installSeconds = [math]::Round($watch.Elapsed.TotalSeconds,2)
$installLog = Get-Content -Raw (Join-Path $TestDirectory 'install.log')
foreach ($phase in @('Checking startup files', 'Testing Jouzu startup', 'Activating Jouzu', 'Jouzu is ready')) {
    if (-not $installLog.Contains($phase)) { throw "Installer did not report activation phase: $phase" }
}
$results.activationPhasesLogged = $true
foreach ($detail in @('Checking SHA-256:', 'Checking required file:', 'Startup file checks completed after', 'Runtime command:', 'Working directory:', 'Runtime process ID:', 'Runtime stdout: jouzu ', 'Runtime exited with code 0 after')) {
    if (-not $installLog.Contains($detail)) { throw "Installer log is missing diagnostic detail: $detail" }
}
$results.activationDiagnosticsLogged = $true
$console = Join-Path $install 'JouzuConsole.exe'
$pointer = Join-Path $install 'current.json'
$id = (Get-Content -Raw -Encoding UTF8 $pointer | ConvertFrom-Json).current
$payload = Join-Path $install "versions\$id"
Write-Host 'Checking installer startup-failure diagnostics'
$pointerBeforeFailure = Get-Content -Raw -Encoding UTF8 $pointer
$failureLogPath = Join-Path $TestDirectory 'startup-failure.log'
try {
    # Force Node to reject startup before it loads the CLI, without changing installed files.
    $env:NODE_OPTIONS = '--jouzu-installer-test-invalid-option'
    $failedInstall = Start-Process $Installer -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/DIR="' + $install + '"'),('/LOG="' + $failureLogPath + '"')) -Wait -PassThru
} finally { $env:NODE_OPTIONS = '' }
if ($failedInstall.ExitCode -eq 0) { throw 'Installer accepted a failed runtime startup check' }
$failureLog = Get-Content -Raw $failureLogPath
foreach ($detail in @('Runtime stderr:', 'NODE_OPTIONS', 'Testing Jouzu startup failed after', 'failed its startup check (exit code', 'Jouzu could not finish installation.', 'Installation log:')) {
    if (-not $failureLog.Contains($detail)) { throw "Installer failure log is missing diagnostic detail: $detail" }
}
if ($failureLog -notmatch 'Jouzu could not finish installation\.\s+Testing Jouzu startup failed after') {
    throw 'Installer error message did not include the launcher failure reason'
}
if ((Get-Content -Raw -Encoding UTF8 $pointer) -ne $pointerBeforeFailure) { throw 'Failed installation changed the active version selection' }
$results.activationFailureDiagnosticsLogged = $true
$watch.Restart()
Write-Host 'Checking bundled CLI and tools'
$results.version = (Run $console @('--version')).Trim()
if ($results.version -notmatch 'jouzu [0-9]+\.[0-9]+\.[0-9]+') { throw 'Unexpected Jouzu version' }
$results.launchSeconds = [math]::Round($watch.Elapsed.TotalSeconds,2)
$settingsPath = Join-Path $data 'agent\settings.json'
$settings = Get-Content -Raw -Encoding UTF8 $settingsPath | ConvertFrom-Json
if ($settings.shellPath -ne (Join-Path $payload 'git\bin\bash.exe')) { throw 'Bundled shell was not selected' }
if ($settings.npmCommand[0] -ne (Join-Path $payload 'node\node.exe')) { throw 'Bundled Node was not selected' }
$results.node = (Run (Join-Path $payload 'node\node.exe') @('--version')).Trim()
$results.npm = (Run (Join-Path $payload 'node\node.exe') @((Join-Path $payload 'node\node_modules\npm\bin\npm-cli.js'),'--version')).Trim()
$results.git = (Run (Join-Path $payload 'git\cmd\git.exe') @('--version')).Trim()
$results.bash = (Run $settings.shellPath @('-c','printf bundled-bash')).Trim()
if ($results.bash -ne 'bundled-bash') { throw 'Bash did not run' }
$results.rg = (Run (Join-Path $payload 'tools\rg.exe') @('--version')).Trim()
$results.fd = (Run (Join-Path $payload 'tools\fd.exe') @('--version')).Trim()
$results.piTools = (Run (Join-Path $payload 'node\node.exe') @((Join-Path $PSScriptRoot 'runtime.test.mjs'),$payload,$project)).Trim()
Write-Host 'Checking local catalog authentication and streamed inference'
$results.network = (Run (Join-Path $payload 'node\node.exe') @((Join-Path $PSScriptRoot 'network.test.mjs'),$console,$project)).Trim()
Push-Location $project
try {
    $doctor = & $console doctor --json 2> (Join-Path $TestDirectory 'doctor.stderr') | Out-String
    $doctor | Set-Content -Encoding UTF8 (Join-Path $TestDirectory 'doctor.json')
    $null = $doctor | ConvertFrom-Json
} finally { Pop-Location }
Write-Host 'Checking settings preservation'
$settings.shellPath = 'C:\custom\bash.exe'
$settings.npmCommand = @('C:\custom\node.exe','C:\custom\npm-cli.js')
$settings | Add-Member -NotePropertyName desktopTestPreserve -NotePropertyValue 'keep me'
$settings | ConvertTo-Json -Depth 20 | Set-Content -Encoding UTF8 $settingsPath
$null = Run $console @('--version')
$preserved = Get-Content -Raw -Encoding UTF8 $settingsPath | ConvertFrom-Json
if ($preserved.shellPath -ne 'C:\custom\bash.exe' -or $preserved.npmCommand[0] -ne 'C:\custom\node.exe' -or $preserved.desktopTestPreserve -ne 'keep me') { throw 'User settings were overwritten' }
$results.customSettingsPreserved = $true
# Restore only test-owned overrides for the interactive smoke test.
$preserved.PSObject.Properties.Remove('shellPath')
$preserved.PSObject.Properties.Remove('npmCommand')
$preserved | ConvertTo-Json -Depth 20 | Set-Content -Encoding UTF8 $settingsPath
# A small development image exercises switching without copying the full image.
Write-Host 'Checking activation, rollback, and corruption rejection'
$fixtureId = '0.0.0-acceptance'
$fixture = Join-Path $install "versions\$fixtureId"
foreach ($dir in @('node','app\node_modules\jouzu\dist','git\bin','terminal')) { New-Item -ItemType Directory -Force (Join-Path $fixture $dir) | Out-Null }
Copy-Item (Join-Path $payload 'node\node.exe') (Join-Path $fixture 'node')
Copy-Item (Join-Path $payload 'node\*.dll') (Join-Path $fixture 'node')
[IO.File]::WriteAllText((Join-Path $fixture 'app\node_modules\jouzu\dist\cli.js'), 'console.log("acceptance fixture");')
foreach ($file in @('bootstrap.mjs','git\bin\bash.exe','terminal\WindowsTerminal.exe')) { [IO.File]::WriteAllText((Join-Path $fixture $file), 'acceptance fixture') }
$entries = @(Get-ChildItem $fixture -Recurse -File | ForEach-Object { @{path=$_.FullName.Substring($fixture.Length+1).Replace('\','/');sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()} })
$manifest = @{releaseId=$fixtureId;signing='unsigned-development';files=$entries} | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText((Join-Path $fixture 'manifest.json'),$manifest)
$null = Run $console @('--activate',$fixtureId)
if ((Get-Content -Raw -Encoding UTF8 $pointer | ConvertFrom-Json).current -ne $fixtureId) { throw 'Activation did not switch' }
$null = Run $console @('--rollback')
if ((Get-Content -Raw -Encoding UTF8 $pointer | ConvertFrom-Json).current -ne $id) { throw 'Rollback did not restore original' }
$before = Get-Content -Raw -Encoding UTF8 $pointer
[IO.File]::WriteAllText((Join-Path $fixture 'bootstrap.mjs'),'corrupt')
$ErrorActionPreference = 'Continue'
& $console --activate $fixtureId 2> (Join-Path $TestDirectory 'corrupt.stderr') | Out-Null
$ErrorActionPreference = 'Stop'
if ($LASTEXITCODE -eq 0 -or (Get-Content -Raw -Encoding UTF8 $pointer) -ne $before) { throw 'Corrupt activation changed active version' }
[IO.File]::WriteAllText((Join-Path $fixture 'bootstrap.mjs'),'acceptance fixture')
# Activation checks startup files; explicit verification checks the whole image.
[IO.File]::WriteAllText((Join-Path $fixture 'git\bin\bash.exe'),'changed non-startup file')
$null = Run $console @('--activate',$fixtureId)
$ErrorActionPreference = 'Continue'
& $console --verify 2> (Join-Path $TestDirectory 'full-corrupt.stderr') | Out-Null
$ErrorActionPreference = 'Stop'
if ($LASTEXITCODE -eq 0) { throw 'Full verification accepted a changed non-startup file' }
[IO.File]::WriteAllText((Join-Path $fixture 'git\bin\bash.exe'),'acceptance fixture')
[IO.File]::WriteAllText((Join-Path $fixture 'unexpected.js'),'unlisted')
$ErrorActionPreference = 'Continue'
& $console --verify 2> (Join-Path $TestDirectory 'unlisted.stderr') | Out-Null
$ErrorActionPreference = 'Stop'
if ($LASTEXITCODE -eq 0) { throw 'Full verification accepted an unlisted file' }
$null = Run $console @('--rollback')
if ((Get-Content -Raw -Encoding UTF8 $pointer | ConvertFrom-Json).current -ne $id) { throw 'Rollback did not restore original' }
$results.rollbackAndCorruption = $true
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Jouzu\Jouzu.lnk'
# WScript.Shell's TargetPath getter reads the ANSI target. Use IShellLinkW
# to check the Unicode target that Explorer launches.
$results.shortcut = (Run $argumentTests @('--shortcut',$shortcut,(Join-Path $install 'Jouzu.exe'))).Trim()
Write-Host 'Verifying installed payload'
$null = Run $console @('--verify')
if ($KeepInstalled) {
    $results.keptInstalled = $true
} else {
    $p = Start-Process (Join-Path $install 'unins000.exe') -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART') -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw 'Uninstaller failed' }
    if (Test-Path $console) { throw 'Uninstaller left launcher' }
    if (-not (Test-Path $settingsPath)) { throw 'Uninstaller removed user data' }
    $results.uninstallPreservedData = $true
}
if ((Get-FileHash -LiteralPath $sentinel).Hash -ne $original) { throw 'Project data changed' }
$results.projectPreserved = $true
$results | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $TestDirectory 'result.json')
Get-Content (Join-Path $TestDirectory 'result.json')
