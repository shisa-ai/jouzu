#!/usr/bin/env node

import { chmodSync } from "node:fs";
import { resolve } from "node:path";

const cli = resolve(import.meta.dirname, "..", "packages", "cli", "dist", "cli.js");
chmodSync(cli, 0o755);
console.log(`marked ${cli} executable`);
