# SessionForge

A Paseo plugin (plus a standalone CLI) that discovers, classifies, and safely cleans up agent coding
sessions across Claude Code, Codex, and Gemini CLI, with a KEEP / ARCHIVE / JUNK heuristic classifier.
See `../GOAL.md` for the full product spec this implements against.

## Layout

```
src/core/                          agent-agnostic domain logic (no Paseo/RPC dependency)
  types.server.ts                  Session / Classification / Adapter interfaces
  claude-transcript.server.ts      streams a single Claude Code .jsonl transcript
  claude-adapter.server.ts         discovers all Claude Code sessions on disk (read-only)
  codex-adapter.server.ts          reads Codex's ~/.codex/state_5.sqlite + thread_history_1.sqlite (read-only)
  gemini-adapter.server.ts         reads Gemini CLI's ~/.gemini/tmp/**/chats/session-*.json (read-only)
  text-utils.server.ts             capFirstMessage() etc. — caps oversized transcript fields before they hit the RPC transport
  activity.server.ts               ACTIVE/RECENT/IDLE/STALE detection with confidence
  classify.server.ts               KEEP/ARCHIVE/JUNK heuristic classifier
  store.server.ts                  SQLite persistence (node:sqlite, ~/.sessionforge/sessionforge.db)
  discover.server.ts               orchestrates adapters -> activity -> classify -> store
  lifecycle-actions.server.ts      archive/restore/cleanup + audit log

src/server/                        Paseo plugin RPC layer (thin wrapper over src/core)
  session-contracts.shared.ts      Zod RPC contracts (session.list, .show, .search, .cleanup, .archive, .restore, .discover)
  session-handlers.server.ts       handler implementations + background rescan scheduling (ADAPTERS = Claude Code, Codex, Gemini CLI)

src/cli/                           standalone CLI (`sessionforge`), imports src/core directly — no daemon needed
  bin.ts                           command dispatch
  format.ts                        table/detail rendering

index.ts                    Paseo plugin entry point — pure plugin.handle()/addSurface()/addSidebarItem() registration only
                             (kept minimal: Paseo's Electron-main "evaluate" introspection pass calls this file's
                             top-level code without a real server context, so it must not directly call anything
                             imported from a .server.ts file)
main.client.tsx              session browser UI (sidebar panel): search/filter/agent tabs, checkboxes + bulk actions,
                              per-provider logo icons, click-to-preview dialog, per-session and per-provider file size
```

## Why a plugin *and* a CLI

Paseo's plugin SDK (`@getpaseo/plugin`) has no mechanism for registering `paseo` subcommands — only RPC
handlers and native UI surfaces (sidebar items, workspace panels, Command Center items). GOAL.md's
`paseo session list`-style CLI examples aren't achievable literally inside a plugin. SessionForge instead
ships both:

- a Paseo plugin (`index.ts`) with an RPC layer and a session-browser UI panel, and
- a standalone CLI (`src/cli/bin.ts`, run as `sessionforge <command>`) that imports `src/core` directly and
  talks to the same local SQLite database — no daemon round-trip required.

Both share one `SessionStore` on disk (`~/.sessionforge/sessionforge.db`), so `sessionforge archive <id>`
from the terminal is reflected immediately in the Paseo UI panel and vice versa.

## Safety model

- Adapters are **read-only**: `ClaudeCodeAdapter` only reads `~/.claude/projects/**/*.jsonl`, `CodexAdapter`
  only reads `~/.codex/state_5.sqlite` and `~/.codex/thread_history_1.sqlite` (opened with `{ readOnly: true }`),
  and `GeminiCliAdapter` only reads `~/.gemini/tmp/**/chats/session-*.json` and `~/.gemini/projects.json`.
  Nothing in SessionForge ever writes to, moves, or deletes an agent-owned transcript/session file.
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
npm run cli -- discover              # scan Claude Code, Codex, and Gemini CLI session storage and populate the local index
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

Once installed, the plugin registers a "SessionForge" sidebar item (session browser: agent-tabbed list with
checkboxes and bulk actions, click-to-preview dialog, search, filter by recommendation, rescan, dry-run
cleanup preview with confirmation, archive/restore, per-session and per-provider on-disk size) and re-scans
Claude Code, Codex, and Gemini CLI sessions every 5 minutes in the background.

## MVP scope vs. GOAL.md

Implemented: Claude Code / Codex / Gemini CLI adapters (§3–§4), ACTIVE/RECENT/IDLE/STALE activity detection
with confidence (§5) — note the live-process signal in `activity.server.ts` currently only recognizes
`claude` processes, so Codex/Gemini sessions never reach `ACTIVE`+`HIGH` confidence that way, only via
timestamp heuristics — local heuristic KEEP/ARCHIVE/JUNK classification with reason/confidence/evidence
(§7), list/show/search/cleanup (dry-run + apply)/archive/restore/audit (§9–§12), SQLite persistence
separate from agent-owned storage (§18), and a native Paseo plugin UI (§15).

Known MVP gap (§6/§22 call for it, not yet built): no real summary generation. The `summary` field exists
in the schema and type model but nothing ever populates it (`discover.server.ts` just carries forward
`existing?.summary ?? null`) — the UI/CLI fall back to title/first-message instead of a generated summary.

Deferred to Phase 2 per GOAL.md: Aider/OpenCode adapters, DUPLICATE/SUPERSEDED classification and
cross-session relationship detection, semantic search, LLM-assisted classification, cross-agent timeline
view (§14).

Deferred to Phase 3 per GOAL.md: configurable/scheduled retention policies (§16, §24) — today there is only
a fixed 5-minute background rescan, no policy engine, no automatic archive-after-N-days or retention-based
delete.
