# Windows prerequisites for Jouzu v0.1

Jouzu v0.1 is an npm developer preview, not a native Windows installer.

## Required environment

- Windows 10 or Windows 11 on x64
- Node.js 22.19 or newer, including npm
- Git for Windows, including Git Bash
- Windows Terminal or another UTF-8-capable terminal

Install Jouzu from a PowerShell or Git Bash session with npm. Pi's coding tools execute Bash commands, so Git Bash must remain installed even when `jouzu` itself is launched from PowerShell or Windows Terminal.

Run the following after installation:

```powershell
jouzu --version
jouzu doctor
jouzu profile plan --profile core
jouzu profile plan --profile ja
jouzu
```

The first interactive launch asks before enabling the optional Japanese-support profile; declining or pressing Enter uses Core. `jouzu doctor` reports missing Git or Bash as an actionable problem. Jouzu does not install, update, or silently select a shell for the user.

## Paths and text

Jouzu uses `%APPDATA%\Jouzu\agent` for configuration and `%LOCALAPPDATA%\Jouzu` for state and cache by default. `--jouzu-home <path>` or `JOUZU_HOME` can select one portable root. The compatibility suite covers spaces, Japanese characters, full-width spaces, UTF-8, UTF-8 BOM, CRLF, and normalization-sensitive names without rewriting user files.

CP932/Shift-JIS is not a managed-profile encoding. If an existing profile target is not valid UTF-8, Jouzu reports an `unsupported-encoding` conflict and leaves its bytes unchanged.

## v0.1 limitations

- No bundled Node, npm, Git, Bash, or terminal.
- No MSI, MSIX, signed installer, portable ZIP, or automatic PATH configuration.
- No claim that all third-party Pi extensions support native Windows.
- Console behavior outside Windows Terminal and Git Bash is not part of the v0.1 support claim.

Standalone archives are explicitly deferred. The npm artifact is the only v0.1 application channel. A self-contained Windows distribution is planned for a later release after native payload, shell, signing, proxy, and package-compatibility qualification.
