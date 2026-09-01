# Contributing to SessionForge

Thanks for considering a contribution. This is a two-package npm workspace — `packages/cli`
(`sessionforge`, the standalone engine) and the repo root (the Paseo plugin, which depends on it). See
[`docs/REFERENCE.md`](docs/REFERENCE.md) for why it's split that way and how the pieces fit together.

## Setup

```bash
git clone https://github.com/4mGLn/sessionforge.git
cd sessionforge
npm install   # sets up the workspace and builds packages/cli's dist/ automatically (a postinstall hook —
              # the root package's imports from "sessionforge" only resolve once that build exists)
```

## Development commands

```bash
npm run typecheck   # tsc --noEmit at the root, then in packages/cli
npm test             # delegates to packages/cli's vitest suite
npm run build         # rebuilds packages/cli's dist/ (run automatically by postinstall, and again here if
                       # you change packages/cli's source without reinstalling)
npm run cli -- <command>   # run the CLI against local TypeScript source via tsx, no build needed
```

`npm test` runs classifier/adapter/store/relationship heuristics, FTS5 search, a real `/proc`-based
activity-detection integration test on Linux, and an end-to-end discover → classify → cleanup/archive/
restore → rescan-doesn't-clobber-lifecycle flow against temp fixtures and a temp SQLite db. macOS/Windows
platform branches (`activity.server.ts`, `trash.server.ts`) are covered locally by mocking `ps`/`lsof`/
PowerShell's `execFile` with realistic output — real macOS/Windows execution only happens in CI.

**If you touch anything under `packages/cli/src/core` that the root plugin imports** (i.e. anything
re-exported from `packages/cli/src/index.ts`), run `npm run build` before `npm run typecheck` at the root —
the root's `import ... from "sessionforge"` resolves against `packages/cli/dist/`, which is git-ignored
build output, not the raw source. `postinstall` handles this on a fresh `npm install`, but it won't pick up
edits made after that without a fresh build. (This exact ordering mistake broke CI once already — see
`.github/workflows/ci.yml`'s comments.)

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every PR: `build` → `typecheck` → `test` → a
CLI-binary smoke test, on a Linux/macOS/Windows matrix, plus a separate job pinned to the `engines.node`
floor (22.16.0) so "latest 22.x" drift in the matrix can't hide a floor-version regression. That floor
isn't arbitrary — `node:sqlite` needs `--experimental-sqlite` before Node 22.13, and its FTS5 support
(which search depends on) isn't compiled in until 22.16; both were found by bisecting real Node versions
with nvm, not by reading release notes, so re-verify empirically before ever lowering it.

## Publishing (maintainers)

`.github/workflows/publish.yml` is manual-trigger only (`workflow_dispatch` from the Actions tab) — it
never runs on a push, and needs an `NPM_TOKEN` repo secret (an npm automation token with publish rights)
configured first. It publishes `packages/cli` with `--provenance` (requires the repo to stay public).

## Making changes

- Keep `docs/MANUAL.md` (how to use it) and `docs/REFERENCE.md` (how it's built) in sync with behavior
  changes — this repo's history has a habit of docs drifting from implementation, so treat a doc update as
  part of the change, not a follow-up.
- Prefer small, focused commits with a clear "why", not just "what" (the diff already shows what changed).
- Run `npm run typecheck && npm test` before opening a PR — CI will catch it either way, but it's faster
  locally.
- If you're adding a new agent adapter, verify it against real on-disk data from that tool before
  considering it done, not just synthetic fixtures — see `packages/cli/src/core/opencode-adapter.server.ts`
  and `aider-adapter.server.ts` for adapters that were built and tuned against real, messy production data
  (including a real bug found and fixed that way: non-ASCII text handling in relationship detection).

## Reporting issues

[GitHub Issues](https://github.com/4mGLn/sessionforge/issues). Include your OS, Node version, and — for a
discovery/parsing bug — which agent adapter is involved, since each reads a completely different on-disk
format.
