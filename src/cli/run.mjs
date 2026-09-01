#!/usr/bin/env node
// Cross-platform launcher for the sessionforge CLI. package.json's "bin" field must point at plain JS,
// not bin.ts directly — on Windows, npm's generated shim runs the target through plain `node`, which
// can't execute TypeScript without a loader. This resolves tsx's own bin entry from its package.json
// (rather than hardcoding its dist path, which could change between tsx versions) and runs bin.ts through
// it, working identically via `node run.mjs` on Linux, macOS, and Windows.
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const tsxPackageJsonPath = require.resolve("tsx/package.json");
const tsxPackageJson = require(tsxPackageJsonPath);
const tsxBinRelative = typeof tsxPackageJson.bin === "string" ? tsxPackageJson.bin : tsxPackageJson.bin.tsx;
const tsxCli = join(dirname(tsxPackageJsonPath), tsxBinRelative);

const result = spawnSync(process.execPath, [tsxCli, join(here, "bin.ts"), ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
