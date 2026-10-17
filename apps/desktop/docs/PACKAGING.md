# Windows packaging

The desktop package uses electron-builder for a Windows x64 unpacked smoke
directory, an assisted per-user NSIS installer, and a portable executable.
Artifacts are written to `apps/desktop/release/`, which is ignored by the
repository.

## Prerequisites

- Run the commands from a Windows x64 host.
- Install the workspace dependencies from the reviewed lockfile. The desktop
  package pins the compatible `electron-builder` 26.x release range.
- Have a usable Python 3 installation and the sidecar build prerequisites
  available. The required preparation command installs the parser dependencies
  and builds the native Windows sidecar; it is not best-effort for packaging.

## Commands

From `apps/desktop/`:

```text
pnpm package:dir
pnpm package:win
```

Both commands first run `prepare:resume-parser-sidecar --target win32-x64`,
then the existing Electron build. `package:dir` asks electron-builder for the
unpacked directory; `package:win` uses the targets in
`electron-builder.json` to create the NSIS and portable Windows artifacts.

The sidecar is copied to
`resources/resume-parser-sidecar/{bin,python}/` beside the packaged app, which
matches the desktop runtime's `process.resourcesPath` lookup. The PyInstaller
working tree is deliberately excluded from the packaged resources.

## Release boundaries

The Windows package uses the tracked Nestor icon in `build/icon.ico`.
The current repository has no license file, signing certificate, update
provider, or publish configuration. Builds are therefore unsigned local
artifacts; the pipeline makes no signing, auto-update, or publishing claim.
Add signing, licensing, updating, and publishing as explicit release decisions
before distributing an installer.

## Current Windows validation

On 2026-08-19, `electron-builder --dir` produced and inspected a Windows x64
bundle containing `Nestor.exe`, `resources/app.asar`, the tracked icon, and
the complete resume-parser sidecar manifest and executable. The inspected
unpacked directory was 585,084,836 bytes. It was not Authenticode-signed.
Regenerate the bundle after the final CSP metadata cleanup and repeat the
isolated packaged-app smoke before treating it as an external release artifact.
