# Windows installer preview

The installer bundles Jouzu, Node.js/npm, Git Bash, Windows Terminal, ripgrep,
fd, and the Visual C++ runtime DLLs. Users do not need to install these tools
or run a terminal command. The target is Windows 10 build 19041 or later on
x64 hardware.

Download the **unsigned v0.1.13 preview** from the
[GitHub release page](https://github.com/shisa-ai/jouzu/releases/tag/v0.1.13).
Windows may show an unknown-publisher warning. Native acceptance tests passed
on Windows Server 2025 x64; clean Windows 10/11 testing remains pending.
Code signing is planned for v0.2.0.

## Use

1. Run `JouzuSetup-…-x64-unsigned.exe` as your normal Windows user.
2. Open Jouzu from the desktop or Start menu.
3. Select **Choose folder…**, choose a **Working folder**, then select **Open**.
   Jouzu opens a terminal and presents first-launch setup, including Shisa AI sign-in.

The working folder is where commands start and relative file paths are resolved.
It can be any folder, not only a Git repository. It does not restrict access to
other files and is separate from Jouzu's settings and credentials.

Select **Remember this folder** to show it on the next launch. The launcher still
shows the path before you select **Open**; **Choose another folder…** changes it.
Uncheck **Remember this folder** and select **Open** to forget the saved path.
Canceling leaves the preference unchanged. If the folder is unavailable, choose
another one; Jouzu does not silently open a different folder.

The launcher stores this preference in `%LOCALAPPDATA%\JouzuDesktop\launcher.json`,
independently of `JOUZU_HOME`. `Jouzu.exe --project <folder>` opens an explicit
working folder without changing the saved preference.

The default installation directory is `%LOCALAPPDATA%\Programs\Jouzu`. Desktop
settings, credentials, sessions, and caches live in
`%LOCALAPPDATA%\JouzuDesktop\data`. `JOUZU_HOME` overrides that location;
`JouzuConsole.exe` also accepts `--jouzu-home`. Keep user data and projects
outside the installation directory, which the uninstaller removes.

The launcher uses an installed Windows Terminal when available and includes
its own copy. Paths containing a semicolon use the Windows console host.
The bundled tools are added only to Jouzu's child-process environment; the
installer does not change the system PATH or install a background service.
Custom `shellPath` and `npmCommand` settings are preserved.

## Updates and repair

The working-folder screen checks GitHub Releases in the background at most once
per 24 hours. When a newer stable x64 installer is available, select **Download
update** to open its download in your browser, then run the downloaded installer.
You can open your working folder while the check runs. If you close the screen
before it finishes, the result is saved for the next launch. Failed checks leave the
launcher usable and retry after 24 hours. Checks use Windows system proxy and
certificate settings. The check scans the 300 most recent releases and stores
its result in `%LOCALAPPDATA%\JouzuDesktop\installer-update.json`.

Run a newer installer to install another version. After extraction, an animated
progress bar shows the startup-file check, CLI startup test, and activation.
Activation checks the manifest, required files, and the hashes of Node, the
bootstrap, and the CLI entry point before changing `current.json`. The startup-file
check and CLI startup test each have a 90-second timeout; stopping a timed-out
runtime and collecting its output can take up to seven additional seconds. A failed check leaves
the active version selection unchanged. The installer saves a log in
`%TEMP%\Setup Log <YYYY-MM-DD> #001.txt` by default; pass
`/LOG="C:\path\install.log"` to choose another path. On failure, the dialog shows
the check's error and the log path. The log records file-check progress, the runtime
command and working directory, process ID, elapsed times, exit code, and runtime
output (the first 50 and last 50 lines, with each line limited to 2,048 characters).
Review the log before sharing it: it contains local paths and runtime output.
The previous version remains available through the Start menu's **Restore
previous Jouzu version** shortcut or `JouzuConsole.exe --rollback`.

`JouzuConsole.exe --verify` checks every file in the active payload and shows
file-count progress. Ordinary launches check the manifest and startup files. Run the same installer again to repair missing or changed program files. Uninstalling keeps user
data and project folders outside the installation directory.

Automatic npm updates are disabled for desktop launches. Checksums in this
unsigned preview detect damage; they do not authenticate a publisher.

The launchers and installer use a transparent JZ dot icon. Its colors preserve
the J and Z positions in the terminal logo's cyan-to-pink gradient. The `.ico`
contains 16, 20, 24, 32, 40, 48, 64, 128, and 256 pixel images. Regenerate the icon
and its SVG source with `python3 packaging/windows/generate-icon.py`; use
`--check` to verify the committed files. Python is not needed to install or run Jouzu.

## Catalog and model connection checks

Desktop launches and the separately installed Windows CLI use different settings
and credentials by default. The desktop home is `%LOCALAPPDATA%\JouzuDesktop\data`;
the regular CLI configuration directory is `%APPDATA%\Jouzu`. Sign in inside the
app you are using, or save a catalog token in its **Settings / Catalogs** screen.
A token set only in PowerShell is inherited by apps launched from that shell,
not by apps opened from the desktop shortcut. `JOUZU_HOME` overrides the desktop
data home.

Use the installed console launcher to diagnose the desktop data home. Adjust the
path if you chose a different installation directory:

```powershell
$jouzu = "$env:LOCALAPPDATA\Programs\Jouzu\JouzuConsole.exe"
& $jouzu --version
& $jouzu catalog refresh
& $jouzu catalog status --json
```

Inspect each source's `lastError`, including sources that have not loaded a catalog
yet. A successful refresh clears the recorded failure. Catalog access and model
access are separate checks: after refreshing, open Jouzu in your working folder,
select a model with `/model`, and send a short prompt. **A live model request may
incur provider charges.** Record the model-request error separately if it fails.

| Error | Check |
| --- | --- |
| Missing credential or HTTP 401 | Sign in again in the desktop app or update that catalog's saved token/environment credential. |
| HTTP 403 | Ask the service operator whether the account has access to the catalog or selected model. |
| HTTP 407 | Check proxy authentication with your network administrator. |
| `ENOTFOUND` or `EAI_AGAIN` | Check the endpoint hostname, DNS resolution, and VPN connection. |
| Certificate verification failure | Check the system clock and Windows certificate trust, including an organization proxy's certificate. |
| Connection refused, reset, or timed out | Check connectivity, the endpoint/port, and proxy configuration. |
| Local filesystem/cache error | Check the Jouzu data folder's permissions and available disk space. |

The launchers set `NODE_USE_SYSTEM_CA=1` and `NODE_USE_ENV_PROXY=1` for bundled
Node. Proxy routing uses `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` in the launched
process's environment. Configuring a browser proxy alone does not configure these
variables. For organization-managed networks, ask your administrator for the
approved proxy configuration and certificate trust setup. For temporary PowerShell
settings, run `JouzuConsole.exe` from that same shell. After changing persistent user
environment variables, sign out of Windows and back in before testing the desktop
shortcut. Repeat both catalog and model checks.

Do not disable certificate verification, disable security software, or run Jouzu
as administrator to bypass a connection error. Before sharing diagnostic output,
remove tokens, account identifiers, private endpoints, proxy credentials, and local
paths. Share the Jouzu version and the catalog/model errors, not credential files.

## Build

Build on x64 Windows with Windows PowerShell 5.1. The script uses the Windows
.NET Framework compiler and downloads the pinned Inno Setup compiler into
the build cache. Internet access is required to download the inputs and
resolve the npm package's dependencies.

Supply a qualified Jouzu npm tarball, its independently recorded SHA-256,
and the full commit that produced it:

```powershell
.\packaging\windows\build.ps1 `
  -JouzuTarball C:\artifacts\jouzu.tgz `
  -TarballSha256 <64-character-sha256> `
  -SourceCommit <40-character-commit> `
  -OutputDirectory C:\artifacts\windows-build `
  -CacheDirectory C:\artifacts\windows-cache `
  -Unsigned
```

The output directory must be new. `dependencies.json` pins the external
archives by SHA-256. The resulting image retains its npm lockfile and
per-file hashes in `manifest.json`. `build-result.json` records the installer
path, SHA-256, payload size, and release identifier. The source commit is
caller-supplied provenance; the builder verifies the tarball's checksum.

## Native acceptance

Run from a non-elevated Windows PowerShell session with a new test directory:

```powershell
.\packaging\windows\test.ps1 `
  -Installer C:\artifacts\windows-build\JouzuSetup-…-x64-unsigned.exe `
  -TestDirectory C:\Users\me\AppData\Local\JouzuAcceptance
```

The launcher tests cover installer selection, cache expiry, offline recovery,
concurrent checks, update-link rendering, and completing a check after the folder
screen closes. They use release fixtures without network requests. After compiling
`LauncherTests.exe`, run `LauncherTests.exe --live-update-check` to check GitHub
and print a published installer URL without downloading it.

The test installs to a path containing Japanese characters and spaces,
hides system Node/Git from PATH, runs the bundled tools and doctor, exercises
Pi file tools with Windows paths, checks custom settings, activates a test version, restores the original, rejects
a corrupt version, and checks uninstall data preservation. It writes
`result.json` and installer/doctor logs. It also runs the installed console launcher
against a local HTTP catalog/model fixture with temporary credentials and a separate
temporary Jouzu home. This checks a rejected catalog token, first-error persistence,
recovery, bearer forwarding, streamed inference, and a rejected model request. It
bypasses environment proxies for loopback and makes no paid model requests. It does
not qualify external HTTPS, proxy authentication, Windows certificate trust, or live
provider credentials. `-KeepInstalled` leaves the test
installation for manual inspection instead of testing uninstall.

The same fixture can be checked on a development host after building the CLI:

```sh
node packaging/windows/network.test.mjs packages/cli/dist/cli.js /path/to/working-folder
```

For native networking qualification, run the connection checks in this document
through `JouzuConsole.exe` on the target Windows machine, both on a direct connection
and on any proxy-managed network you support. Record the Windows/Jouzu versions,
network configuration without secrets, catalog result, and model-request result.

Also open the desktop shortcut and check the working-folder screen and first-launch
screen in the terminal. Check Tab navigation, Enter to open, Escape to cancel,
remembering and forgetting a folder, and reopening after the saved folder is deleted
or a removable drive is disconnected. Canceling either dialog must preserve the
saved preference. Check the icon in Explorer, shortcuts, and the launch window at
100%, 150%, and 200% display scaling. Clean Windows 10 and Windows 11 testing remains
pending for the v0.1.10 preview; a Windows Server run alone does not qualify
those desktop versions. Provider sign-in and microphone access require
separate interactive checks.
