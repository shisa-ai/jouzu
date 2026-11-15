# Development

## Requirements

- Node.js 22.19 or newer, npm 11.13.0 or newer, Git, and Bash on `PATH`
- Go. The build downloads the exact toolchain pinned in `upstream/textguard/source.lock.json` for [textguard-go](https://github.com/shisa-ai/textguard-go).
- For the full `npm test` suite: `uv` and Python 3.10 or newer

## npm version

Source builds require npm 11.13.0 or newer. Older npm versions can reject the
workspace's direct Git dependencies with `EALLOWGIT` under this checkout's
`allow-git=root` policy. `dev-build.sh` checks the npm version before installing.

Update npm without changing the project's Git-dependency policy:

```bash
npm install -g npm@11.21.1
npm --version
./dev-build.sh link
```

npm 11 supports Jouzu's Node.js minimum. npm 12 has a newer Node.js requirement;
check its supported Node.js versions before choosing that major version. The
source-build requirement does not apply to installing Jouzu's published package.

## Build and run

```bash
npm run dev:setup                     # install, check, build, and smoke-test
node packages/cli/dist/cli.js         # run this checkout
npm run dev:link                      # optional: point global jz/jouzu at this checkout
```

- `dev:setup` installs dependencies with install scripts disabled, and reinstalls when manifests, lockfiles, or pinned patches change.
- Builds in one clone take turns through a lock, so they cannot overwrite each other's dependencies.
- No provider key is needed.
- `dev:setup` does not change global commands or install Git hooks. If global commands already point here, rebuilding updates them.

## Version identifiers

Development builds record build time (UTC), Git commit, and uncommitted changes:

```text
0.1.7-dev.20260905-010203+g215b2188        # clean checkout
0.1.7-dev.20260905-010203+g215b2188.dirty  # uncommitted changes
```

`npm run build` drops this information for release packages.

## Rebuild after Git operations

```bash
./dev-build.sh install-hooks
./dev-build.sh uninstall-hooks        # removes only these hooks
```

- Hooks rebuild without changing global links, keep existing hooks, and report build failures without failing the Git command.
- They apply only to the checkout that installed them. Set `JOUZU_REPO` to use another local checkout.
- Tested on Linux. The test suite, `npm run test:dev-build`, also needs Python 3.

## Windows

- Close Jouzu sessions and test processes from this checkout before rebuilding. Windows locks loaded native modules.
- Archive extraction uses Windows' built-in `tar.exe`.
- Without Bash:

```bash
npm ci --ignore-scripts
npm run build:dev
node packages/cli/dist/cli.js
npm link --workspace packages/cli --ignore-scripts   # optional global link
```

## Tests and release checks

- `npm run release:check` runs the full release gate.
- See [Testing](testing.md) for test suites and [Architecture](architecture.md) for the module map.
