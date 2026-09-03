# Windows prerequisites for Jouzu v0.1

Jouzu v0.1 is an npm developer preview, not a native Windows installer.

Jouzu v0.1.5's bundled extension set passed the full Linux, macOS, and Windows qualification matrix with Node 22 and 24. The prerequisites below describe the v0.1 npm environment.

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

When the isolated Jouzu agent root has no `keybindings.json`, the first interactive launch seeds `Ctrl+Enter` for follow-up and `Ctrl+Up` for dequeue; `Tab` retains Pi autocomplete. On upgrade from v0.1.0, Jouzu backs up and replaces only an exact Jouzu-owned `Tab` follow-up entry. User-owned or modified bindings remain unchanged. Use `jouzu keybindings plan` for the effective plan and portability notes; Windows Terminal must deliver modified Enter and arrow keys to the application.

For real global npm installations, the first eligible interactive launch checks for a newer Jouzu package before entering Pi. Jouzu uses the npm client on `PATH`, verifies the exact tarball SHA-512 and installed runtime, restores the previous locally packed version on a failed verification, and relaunches the original command after success. Project-local, source, and ephemeral `npx` invocations are not rewritten. Use `jouzu self-update status` for classification or `JOUZU_NO_UPDATE=1` for a one-run opt-out.

## Paths and text

Jouzu uses `%APPDATA%\Jouzu\agent` for configuration and `%LOCALAPPDATA%\Jouzu` for state and cache by default. `--jouzu-home <path>` or `JOUZU_HOME` can select one portable root. The compatibility suite covers spaces, Japanese characters, full-width spaces, UTF-8, UTF-8 BOM, CRLF, and normalization-sensitive names without rewriting user files.

CP932/Shift-JIS is not a managed-profile encoding. If an existing profile target is not valid UTF-8, Jouzu reports an `unsupported-encoding` conflict and leaves its bytes unchanged.

## v0.1 limitations

- No bundled Node, npm, Git, Bash, or terminal.
- No MSI, MSIX, signed installer, portable ZIP, or automatic PATH configuration.
- No claim that all third-party Pi extensions support native Windows.
- Console behavior outside Windows Terminal and Git Bash is not part of the v0.1 support claim.

Standalone archives are explicitly deferred. The npm artifact is the only v0.1 application channel. A self-contained Windows distribution is planned for a later release after native payload, shell, signing, proxy, and package-compatibility qualification.
