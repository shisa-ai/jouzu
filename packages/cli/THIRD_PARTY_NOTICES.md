# Third-party notices

Jouzu bundles the following release-owned Pi extensions and their runtime dependencies. Package license files and notices remain in each bundled package directory. `dist/release-extensions.json` records exact versions, source revisions, integrity values, resource entrypoints, and repository URLs.

| Package | Version or revision | License evidence |
| --- | --- | --- |
| `pi-schedule-prompt` | 0.4.1 | MIT; `LICENSE` |
| `@vanillagreen/pi-background-tasks` | 2.0.0 | MIT in `package.json`; `THIRD_PARTY_NOTICES.md` contains the upstream attribution and license text |
| `pi-smart-fetch` | 0.3.17 | MIT; `LICENSE` |
| `@the-forge-flow/camoufox-pi` | 0.2.1 | MIT; `LICENSE` |
| `pi-code-previews` | 0.1.36 | MIT; `LICENSE` |
| `@lhl/pi-tasks` | `be52712d391d3b3771204222f203c4e06175d3da` | MIT; `LICENSE` |
| `@lhl/pi-goal` | `a38ff5f0aab12a4591d05845de4f0a16033530ca` | MIT; `LICENSE` |
| `pi-multiloop` | `491968d257a906f34a47f8bf77f065d6348666cc` | MIT; `LICENSE` |
| `@sting8k/pi-vcc` | 0.6.1 | The upstream `README.md` declares MIT under its License heading; the package has no separate license file |
| `pi-skill-dollar` | 0.1.0 | MIT; `LICENSE` |
| `camoufox-js` | 0.11.5 | MPL-2.0; `LICENSE.md` |
| `playwright-core` | 1.60.0 | Apache-2.0; `LICENSE` and `NOTICE` |
| `better-sqlite3` | 13.0.1 | MIT; `LICENSE` |

Jouzu loads Camoufox through a product adapter that starts the browser only when a Camoufox tool is called. The bundle pins Camoufox's client and Playwright dependencies to the versions above and removes obsolete Pi peer-package declarations. Jouzu applies its supported Node floor (`>=22.19.0`) to the bundled `pi-smart-fetch` metadata.

The package bundle also contains transitive dependencies. Their package metadata and included license or notice files remain with their source files under `node_modules`.
