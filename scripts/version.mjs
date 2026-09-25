#!/usr/bin/env node
// The two packages are released together, at one version, and the plugin
// depends on exactly that version of @bombadil/hermetic.
//
//   node scripts/version.mjs 0.4.0          sets it everywhere and updates package-lock.json
//   node scripts/version.mjs --check 0.4.0  fails unless everything already says 0.4.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const CORE = "packages/hermetic/package.json";
const PLUGIN = "packages/eslint-plugin-hermetic/package.json";

const checking = process.argv[2] === "--check";
const version = process.argv[checking ? 3 : 2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: node scripts/version.mjs [--check] <version>, such as 0.4.0 or 0.4.0-beta.1");
  process.exit(1);
}

const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const write = (file, json) => fs.writeFileSync(path.join(root, file), `${JSON.stringify(json, null, 2)}\n`);
const core = read(CORE);
const plugin = read(PLUGIN);

if (checking) {
  const found = {
    [`${core.name}'s version`]: core.version,
    [`${plugin.name}'s version`]: plugin.version,
    [`${plugin.name}'s dependency on ${core.name}`]: plugin.dependencies[core.name],
  };
  const wrong = Object.entries(found).filter(([, value]) => value !== version);
  for (const [what, value] of wrong) console.error(`::error::${what} is ${value}, not ${version}.`);
  process.exit(wrong.length === 0 ? 0 : 1);
}

core.version = version;
plugin.version = version;
plugin.dependencies[core.name] = version;
write(CORE, core);
write(PLUGIN, plugin);
execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
console.log(`${core.name} and ${plugin.name} are at ${version}.`);
