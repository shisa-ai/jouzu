# Third-party notices

Jouzu distributes the following release-owned Pi extensions and their default runtime dependencies. License files and notices remain in each bundled package directory. `dist/release-extensions.json` records exact versions, source revisions, integrity values, resource entrypoints, and repository URLs.

| Package | Version or revision | License evidence |
| --- | --- | --- |
| `pi-schedule-prompt` | 0.4.1 | MIT; `LICENSE` |
| `@vanillagreen/pi-background-tasks` | 2.0.0 | MIT in `package.json`; `THIRD_PARTY_NOTICES.md` contains the upstream attribution and license text |
| `pi-webaio` | `1db1e2807376f9f2df8baa5796313894bd6f5113` (1.0.5) | MIT; `LICENSE` |
| `@sinclair/typebox` | 0.34.52 | MIT; `license` |
| `pi-code-previews` | 0.1.36 | MIT; `LICENSE` |
| `@lhl/pi-tasks` | `fc2e88bccfe0c5b818daea7092667d75e8e14b3d` | MIT; `LICENSE` |
| `pi-multiloop` | `cffc0e58987249dd16d74f1b554623cd103d10d3` (v0.4.0) | MIT; `LICENSE` |
| `@sting8k/pi-vcc` | 0.7.0 | The upstream `README.md` declares MIT under its License heading; the package has no separate license file |
| `pi-skill-dollar` | `4bff5734d87c4f4725d81a4ea1d1c1283c22423c` (v0.2.0) | MIT; `LICENSE` |
| `esbuild` | 0.28.1 | MIT; `LICENSE.md` |
| `typebox` | 1.3.7 | MIT; `license` |

The bundled `pi-webaio` entrypoint supplies Jouzu's static `web_fetch` and `batch_web_fetch` tools without starting a browser. The package bundle also contains transitive dependencies. Their package metadata and included license or notice files remain with their source files under `node_modules`.

## First-use Camoufox runtime

Jouzu does not distribute or install the following packages by default. The first `tff-fetch_url` or `tff-search_web` call installs them from the npm registry under Jouzu state using the exact versions and SHA-512 integrity values in `camoufox-runtime/package-lock.json`.

| Package | Version | License |
| --- | --- | --- |
| `@the-forge-flow/camoufox-pi` | 0.2.1 | MIT |
| `camoufox-js` | 0.12.0 | MPL-2.0 |
| `ua-parser-js` | 2.0.10 | AGPL-3.0-or-later |
| `impit` | 0.11.0 | Apache-2.0 |
| `playwright-core` | 1.60.0 | Apache-2.0 |
| `better-sqlite3` | 13.0.3 | MIT |
| `@sinclair/typebox` | 0.34.52 | MIT |

Camoufox downloads its browser binary on the first browser launch if the binary is absent. If `better-sqlite3` cannot load because of the host C or C++ library version, Jouzu launches Camoufox with WebGL disabled. `JOUZU_CAMOUFOX_LIBRARY_PATH` adds a compatible library directory only to the browser child.
