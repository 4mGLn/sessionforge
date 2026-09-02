#!/usr/bin/env node
// Packages this repo's Paseo plugin (index.ts, main.client.tsx, src/server/*) into a self-contained
// directory, then tars it — the artifact `sessionforge wire-paseo` downloads and points a local
// `paseo plugin install` at, so a user doesn't need to clone this whole monorepo just to get the plugin.
//
// This can't just be "git clone the repo and let Paseo build it" (verified empirically): Paseo's
// git-source plugin install does a fresh checkout and bundles the plugin directly, with no npm-workspace
// dependency resolution step, so it fails to resolve the plugin's one real runtime dependency,
// `@aadaa88/sessionforge` (an npm workspace symlink in this monorepo, not a real directory). Instead this
// script bakes a real, non-symlinked copy of that package's built output into node_modules — something
// that works when extracted standalone on a completely different machine, unlike a symlink.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Matches the same "dev-main" sentinel packages/cli/scripts/build-binary.mjs falls back to when built
// outside release.yml — kept as a plain string literal (not imported) since this script runs standalone,
// before the TS in packages/cli is necessarily even built yet.
const PLUGIN_VERSION_FILE = ".sessionforge-version";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(repoRoot, "build");
const stageDir = join(buildDir, "paseo-plugin");
const archivePath = join(buildDir, "sessionforge-paseo-plugin.tar.gz");

// Everything the plugin's own source actually imports (`index.ts`, `main.client.tsx`, `src/server/*`) —
// verified by reading the actual import statements, not guessed. `tsconfig.json` isn't required at
// runtime (Paseo transpiles the plugin's TS/TSX on the fly) but costs nothing to include.
const PLUGIN_FILES = ["paseo-plugin.json", "paseo-plugin.d.ts", "index.ts", "main.client.tsx", "package.json", "tsconfig.json", "src/server"];

function main() {
  const cliDist = join(repoRoot, "packages", "cli", "dist");
  if (!existsSync(cliDist)) {
    throw new Error(`${cliDist} is missing — run "npm run build" (or "npm install", which does it via postinstall) first.`);
  }

  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  for (const rel of PLUGIN_FILES) {
    cpSync(join(repoRoot, rel), join(stageDir, rel), { recursive: true });
  }

  // A real copy, not the workspace symlink at the source repo's own node_modules/@aadaa88/sessionforge —
  // symlinks don't survive being tarred and extracted on someone else's machine.
  const cliPackageDest = join(stageDir, "node_modules", "@aadaa88", "sessionforge");
  mkdirSync(cliPackageDest, { recursive: true });
  cpSync(cliDist, join(cliPackageDest, "dist"), { recursive: true });
  cpSync(join(repoRoot, "packages", "cli", "package.json"), join(cliPackageDest, "package.json"));
  cpSync(join(repoRoot, "packages", "cli", "LICENSE"), join(cliPackageDest, "LICENSE"));

  // Lets `sessionforge paseo-status` report drift between what's actually installed and the running CLI's
  // own version — release.yml passes the real tag via this env var; unset (a local/manual package:plugin
  // run) falls back to the same "dev-main" sentinel the CLI binary itself uses.
  writeFileSync(join(stageDir, PLUGIN_VERSION_FILE), `${process.env.SESSIONFORGE_VERSION ?? "dev-main"}\n`);

  rmSync(archivePath, { force: true });
  // tar ships on Linux/macOS by default and as bsdtar on Windows 10 1803+ / Windows 11 — same assumption
  // install.sh/install.ps1 and this project's other platform-support claims already make.
  execFileSync("tar", ["-czf", archivePath, "-C", stageDir, "."], { stdio: "inherit" });

  console.log(`Packaged Paseo plugin: ${archivePath}`);
}

main();
