# Third-party notices

Jouzu distributes the following release-owned Pi extensions and their runtime dependencies. License files and notices remain in each bundled package directory. `dist/release-extensions.json` records exact versions, source revisions, integrity values, resource entrypoints, and repository URLs.

| Package | Version or revision | License evidence |
| --- | --- | --- |
| `pi-schedule-prompt` | 0.4.1 | MIT; `LICENSE` |
| `@vanillagreen/pi-background-tasks` | 2.0.0 | MIT in `package.json`; `THIRD_PARTY_NOTICES.md` contains the upstream attribution and license text |
| `pi-webaio` | `78b56cd784440d31159e0a6b159176f4ba375030` (1.0.5) | MIT; `LICENSE` |
| `@sinclair/typebox` | 0.34.52 | MIT; `license` |
| `@the-forge-flow/camoufox-pi` | 0.2.1 | MIT; `LICENSE` |
| `pi-code-previews` | 0.1.36 | MIT; `LICENSE` |
| `@lhl/pi-tasks` | `fc2e88bccfe0c5b818daea7092667d75e8e14b3d` | MIT; `LICENSE` |
| `pi-multiloop` | `cffc0e58987249dd16d74f1b554623cd103d10d3` (v0.4.0) | MIT; `LICENSE` |
| `@sting8k/pi-vcc` | 0.7.0 | The upstream `README.md` declares MIT under its License heading; the package has no separate license file |
| `pi-skill-dollar` | `4bff5734d87c4f4725d81a4ea1d1c1283c22423c` (v0.2.0) | MIT; `LICENSE` |
| `camoufox-js` | 0.12.0 | MPL-2.0; `LICENSE.md` |
| `impit` | 0.11.0 | Apache-2.0; package metadata |
| `ua-parser-js` | 1.0.41 | MIT; `LICENSE.md` |
| `playwright-core` | 1.60.0 | Apache-2.0; `LICENSE` and `NOTICE` |
| `esbuild` | 0.28.1 | MIT; `LICENSE.md` |
| `typebox` | 1.3.7 | MIT; `license` |
| `better-sqlite3` | 13.0.3 | MIT; `LICENSE` |

Jouzu loads Camoufox through a product adapter that starts the browser only when a Camoufox tool is called. The bundle pins Camoufox's client and Playwright dependencies to the versions above and removes obsolete Pi peer-package declarations. Jouzu bundles the Camoufox JavaScript runtime without its package-owned `better-sqlite3`, `impit`, and `ua-parser-js` dependency declarations, then installs the selected versions directly. The selected `ua-parser-js` version is MIT-licensed 1.0.41. The bundled `pi-webaio` entrypoint supplies Jouzu's static `web_fetch` and `batch_web_fetch` tools without starting a browser. If the selected platform's `better-sqlite3` binary cannot load because its glibc/libstdc++ floor is newer than the host, the adapter launches Camoufox with WebGL disabled instead of failing the whole browser tool. Operators on an older system NSS can set `JOUZU_CAMOUFOX_LIBRARY_PATH` to a compatible library directory; Jouzu adds it only to the browser child rather than changing the Node process's loader path.

The package bundle also contains transitive dependencies. Their package metadata and included license or notice files remain with their source files under `node_modules`.
