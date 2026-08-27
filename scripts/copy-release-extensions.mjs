#!/usr/bin/env node

import { copyFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "packages", "cli", "release-extensions.json");
const target = resolve(root, "packages", "cli", "dist", "release-extensions.json");
copyFileSync(source, target);
console.log(`copied ${source} to ${target}`);
