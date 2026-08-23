#!/usr/bin/env node

import { chmodSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const dist = resolve(import.meta.dirname, "..", "packages", "cli", "dist");
const cli = resolve(dist, "cli.js");
rmSync(resolve(dist, "build-info.json"), { force: true });
chmodSync(cli, 0o755);
console.log(`marked ${cli} executable`);
