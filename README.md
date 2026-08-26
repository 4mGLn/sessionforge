# SessionForge

A Paseo plugin (plus a standalone CLI) that discovers, classifies, and safely cleans up agent coding
sessions. MVP scope covers Claude Code only, with a KEEP / ARCHIVE / JUNK heuristic classifier. See
`../GOALD.md` for the full product spec this implements against.

## Layout

```
src/core/                  agent-agnostic domain logic (no Paseo/RPC dependency)
  types.ts                 Session / Classification / Adapter interfaces
  claude-transcript.ts      streams a single Claude Code .jsonl transcript
  claude-adapter.ts          discovers all Claude Code sessions on disk (read-only)
  activity.ts                 ACTIVE/RECENT/IDLE/STALE detection with confidence
  classify.ts                  KEEP/ARCHIVE/JUNK heuristic classifier
  store.ts                     SQLite persistence (node:sqlite, ~/.sessionforge/sessionforge.db)
  discover.ts                   orchestrates adapters -> activity -> classify -> store
  lifecycle-actions.ts           archive/restore/cleanup + audit log

src/server/                 Paseo plugin RPC layer (thin wrapper over src/core)
  session-contracts.shared.ts  Zod RPC contracts (session.list, .show, .search, .cleanup, .archive, .restore, .discover)
  session-handlers.server.ts    handler implementations

src/cli/                    standalone CLI (`sessionforge`), imports src/core directly — no daemon needed
  bin.ts                       command dispatch
  format.ts                     table/detail rendering

index.ts                    Paseo plugin entry point (RPC registration + native UI surface + periodic rescan)
main.client.tsx              session browser UI (sidebar panel)
```

## Why a plugin *and* a CLI

Paseo's plugin SDK (`@getpaseo/plugin`) has no mechanism for registering `paseo` subcommands — only RPC
handlers and native UI surfaces (sidebar items, workspace panels, Command Center items). GOALD.md's
`paseo session list`-style CLI examples aren't achievable literally inside a plugin. SessionForge instead
ships both:

- a Paseo plugin (`index.ts`) with an RPC layer and a session-browser UI panel, and
- a standalone CLI (`src/cli/bin.ts`, run as `sessionforge <command>`) that imports `src/core` directly and
  talks to the same local SQLite database — no daemon round-trip required.

Both share one `SessionStore` on disk (`~/.sessionforge/sessionforge.db`), so `sessionforge archive <id>`
from the terminal is reflected immediately in the Paseo UI panel and vice versa.

## Safety model

- Adapters are **read-only**: `ClaudeCodeAdapter` only reads `~/.claude/projects/**/*.jsonl`. Nothing in
  SessionForge ever writes to, moves, or deletes an agent-owned transcript file.
- "Archive" and "cleanup" only change SessionForge's own `lifecycle` field in its own database
  (`ARCHIVED` / `JUNK`). There is no permanent delete in this MVP — everything is restorable via
  `sessionforge restore <id>`.
- `cleanup` defaults to `--dry-run` (prints candidates, changes nothing). Pass `--apply` to actually trash
  the current JUNK candidates.
- Every archive/restore/cleanup action is recorded in an `audit_log` table (`sessionforge audit [id]`).
- Once a session's lifecycle is explicitly set by a user action (`ARCHIVED`/`JUNK`), subsequent
  `discover` rescans will not silently flip it back — see `STICKY_LIFECYCLES` in `src/core/discover.ts`.

## Running the CLI

```bash
npm install
npm run cli -- discover              # scan ~/.claude/projects and populate the local index
npm run cli -- list                  # table view; add --json for machine-readable output
npm run cli -- list --category junk --older-than 30d
npm run cli -- show <session-id>
npm run cli -- search "postgresql"
npm run cli -- cleanup               # dry run (default) — nothing changes
npm run cli -- cleanup --apply       # move current JUNK candidates to trash (still restorable)
npm run cli -- archive <session-id> --reason "done"
npm run cli -- restore <session-id>
npm run cli -- audit [session-id]
```

`npm run typecheck` runs `tsc --noEmit` over the whole project (plugin + CLI + core).
`npm test` (or `npx vitest run`) runs the unit/integration suite: classifier heuristics, the Claude
Code adapter's JSONL parsing (sidechains, malformed lines, `ai-title`), and an end-to-end
discover -> classify -> cleanup/archive/restore -> rescan-doesn't-clobber-lifecycle flow against a
temp `~/.claude`-shaped fixture and a temp SQLite db.

For scripting/automation, use `--json` together with npm's `--silent` flag so npm's own
`> sessionforge@0.0.0 cli` banner doesn't leak into the piped output, e.g.
`npm run --silent cli -- list --json | jq .`. Alternatively call `npx tsx src/cli/bin.ts ...` directly.

## Installing the Paseo plugin

```bash
paseo plugin install /path/to/sessionforge
paseo plugin reload sessionforge   # after any source change — never auto-reloaded
paseo plugin logs sessionforge     # tail console.log/console.error from the server contribution
```

**Known issue in this environment**: `paseo plugin install` exits cleanly (code 0) after resolving its
login shell environment, but produces no further output and does not write a `plugins` entry to
`~/.paseo/config.json`. This reproduces even with the sandbox restriction on subprocess spawning lifted,
so it looks like a headless/no-display quirk in this specific Electron-CLI build rather than an issue in
SessionForge itself — `paseo status` and `paseo plugin ls` (which don't need to spawn a build step) work
fine in the same environment. Try `paseo plugin install` from a normal interactive terminal outside an
agent sandbox; if it still hangs, `paseo plugin logs sessionforge` and `~/.paseo/daemon.log` are the next
places to look.

Once installed, the plugin registers a "SessionForge" sidebar item (session browser: search, filter by
recommendation, rescan, dry-run cleanup preview, archive/restore) and re-scans Claude Code sessions every
5 minutes in the background.

## MVP scope vs. GOALD.md

Implemented: Claude Code adapter, ACTIVE/RECENT/IDLE/STALE activity detection with confidence, local
heuristic KEEP/ARCHIVE/JUNK classification with reason/confidence/evidence, list/show/search/cleanup
(dry-run + apply)/archive/restore/audit, SQLite persistence separate from agent-owned storage.

Deferred to Phase 2 per GOALD.md: Codex/Gemini CLI/Aider/OpenCode adapters, DUPLICATE/SUPERSEDED
classification and cross-session relationship detection, semantic search, LLM-assisted classification,
cross-agent timeline view, scheduled/policy-driven automation beyond the built-in 5-minute rescan.
