#!/usr/bin/env node
// Builds a standalone, dependency-free sessionforge binary for the current OS/arch using Node's Single
// Executable Application (SEA) support — verified empirically (not assumed) to work correctly with
// node:sqlite, since that's a built-in compiled into the node binary itself rather than a separate native
// addon SEA would need special handling for. Binaries are large (~100MB+) because they embed the whole
// Node runtime, same tradeoff deno/bun single-file binaries make. Must run natively on each target OS/arch
// — SEA binaries aren't cross-compilable from one machine — see .github/workflows/release.yml, which runs
// this once per matrix OS to cover Linux, both macOS architectures, and Windows.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const buildDir = join(packageRoot, "build");

// Resolved via require.resolve rather than a guessed node_modules/.bin path — npm workspaces hoist most
// devDependencies to the repo root's node_modules, not each package's own, so a hardcoded local path
// breaks depending on exactly what else is installed.
function resolvePostjectCli() {
  const require = createRequire(import.meta.url);
  const postjectPkgPath = require.resolve("postject/package.json");
  const postjectPkg = require(postjectPkgPath);
  const binRelative = typeof postjectPkg.bin === "string" ? postjectPkg.bin : postjectPkg.bin.postject;
  return join(dirname(postjectPkgPath), binRelative);
}

function targetTriple() {
  const p = platform();
  const a = arch();
  if (p === "linux" && a === "x64") return "x86_64-unknown-linux-gnu";
  if (p === "linux" && a === "arm64") return "aarch64-unknown-linux-gnu";
  if (p === "darwin" && a === "x64") return "x86_64-apple-darwin";
  if (p === "darwin" && a === "arm64") return "aarch64-apple-darwin";
  if (p === "win32" && a === "x64") return "x86_64-pc-windows-msvc";
  throw new Error(`Unsupported platform/arch combination for binary build: ${p}/${a}`);
}

async function main() {
  const triple = targetTriple();
  const isWindows = platform() === "win32";
  const isMac = platform() === "darwin";
  const outputName = `sessionforge-${triple}${isWindows ? ".exe" : ""}`;

  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });

  console.log(`Bundling CLI entry point for ${triple}...`);
  await esbuild.build({
    entryPoints: [join(packageRoot, "src", "cli", "bin.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: join(buildDir, "bundle.cjs"),
    // node:sqlite etc. are compiled into the node binary itself, not real npm packages — esbuild's
    // platform:"node" already treats bare node builtins as external automatically, this just makes it
    // explicit for both the unprefixed and "node:"-prefixed spellings used across the source.
    external: ["node:sqlite"],
    logLevel: "info",
  });

  const seaConfigPath = join(buildDir, "sea-config.json");
  const blobPath = join(buildDir, "sea-prep.blob");
  writeFileSync(
    seaConfigPath,
    JSON.stringify({ main: join(buildDir, "bundle.cjs"), output: blobPath, disableExperimentalSEAWarning: true }, null, 2),
  );

  console.log("Generating SEA blob...");
  execFileSync(process.execPath, ["--experimental-sea-config", seaConfigPath], { stdio: "inherit" });

  const outputPath = join(buildDir, outputName);
  copyFileSync(process.execPath, outputPath);

  if (isWindows) {
    // Node's SEA docs recommend removing any existing signature from the copied node.exe before
    // injection, when signtool is available — best-effort, since a fresh runner's node.exe is typically
    // unsigned already and this step failing shouldn't block the build.
    try {
      execFileSync("signtool", ["remove", "/s", outputPath], { stdio: "inherit" });
    } catch {
      // no signtool, or nothing to remove — fine
    }
  }

  console.log("Injecting SEA blob into binary...");
  const postjectArgs = [outputPath, "NODE_SEA_BLOB", blobPath, "--sentinel-fuse", SEA_FUSE];
  if (isMac) postjectArgs.push("--macho-segment-name", "NODE_SEA");
  execFileSync(process.execPath, [resolvePostjectCli(), ...postjectArgs], { stdio: "inherit" });

  if (isMac) {
    console.log("Ad-hoc code-signing (no paid Apple Developer certificate — this only satisfies Gatekeeper's basic check, it doesn't remove the first-run 'unidentified developer' prompt)...");
    execFileSync("codesign", ["--sign", "-", outputPath], { stdio: "inherit" });
  }

  if (!isWindows) chmodSync(outputPath, 0o755);

  console.log(`Built ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
