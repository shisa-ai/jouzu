# Jouzu Development Guide

Jouzu is the public, canonical source for all distributable product code, tests, packages, installers, and public documentation.

## Ground Rules

- Keep the root `README.md` minimal until the v0.1 product launch.
- Use exact versions for direct dependencies.
- Stage files explicitly; never use `git add .`, `git add -A`, or `git commit -a`.
- Run `npm run release:check` before publishing.
- Product implementation starts here, not in `jouzu-dev`.
- Generic Pi fixes and missing extension hooks should be proposed upstream.
- Do not add Pi source as a submodule or vendored tree.

## Package Releases

- First-party packages use lockstep versions initially.
- npm publication uses public access and provenance where the publishing environment supports it.
- The PyPI `jouzu` package is a thin launcher/reservation package, not a separate implementation.
