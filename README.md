# SessionForge

A Paseo plugin (plus a standalone CLI) that discovers, classifies, and safely cleans up agent coding
sessions across Claude Code, Codex, Gemini CLI, OpenCode, and Aider, with a KEEP / ARCHIVE / JUNK heuristic
classifier. See `../GOAL.md` for the full product spec this implements against.

## Layout

```
src/core/                          agent-agnostic domain logic (no Paseo/RPC dependency)
  types.server.ts                  Session / Classification / Adapter interfaces
  claude-transcript.server.ts      streams a single Claude Code .jsonl transcript
  claude-adapter.server.ts         discovers all Claude Code sessions on disk (read-only)
  codex-adapter.server.ts          reads Codex's ~/.codex/state_5.sqlite + thread_history_1.sqlite (read-only)
  gemini-adapter.server.ts         reads Gemini CLI's ~/.gemini/tmp/**/chats/session-*.json (read-only)
  opencode-adapter.server.ts       reads OpenCode's ~/.local/share/opencode/opencode.db (read-only; no delete() —
                                    every session shares one live SQLite db, no discrete per-session file to move)
  aider-adapter.server.ts          parses .aider.chat.history.md files found under AIDER_SEARCH_ROOTS (opt-in,
                                    unset by default — Aider has no central session directory to read); no delete()
                                    either, since sessions share one growing per-repo log file
  text-utils.server.ts             capFirstMessage() etc. — caps oversized transcript fields before they hit the RPC transport
  activity.server.ts               ACTIVE/RECENT/IDLE/STALE detection with confidence
  classify.server.ts               KEEP/ARCHIVE/JUNK heuristic classifier
  summarize.server.ts              local heuristic one-line "concise summary" (title/first-message + classifier outcome, no LLM)
  relationships.server.ts          local heuristic DUPLICATE/SUPERSEDED cross-session detection (same workspace, topic word-overlap, timing)
  trash.server.ts                  OS-dispatched move-to-trash for delete (Linux XDG Trash / macOS ~/.Trash / Windows Recycle Bin)
  store.server.ts                  SQLite persistence + FTS5 ranked search (node:sqlite, ~/.sessionforge/sessionforge.db)
  discover.server.ts               orchestrates adapters -> activity -> classify -> summarize -> store -> relationships
  lifecycle-actions.server.ts      archive/restore/delete/cleanup + audit log

src/server/                        Paseo plugin RPC layer (thin wrapper over src/core)
  session-contracts.shared.ts      Zod RPC contracts (session.list, .show, .search, .cleanup, .archive, .restore, .delete, .discover)
  session-handlers.server.ts       handler implementations + background rescan scheduling (ADAPTERS = Claude Code, Codex, Gemini CLI, OpenCode, Aider)

src/cli/                           standalone CLI (`sessionforge`), imports src/core directly — no daemon needed
  bin.ts                           command dispatch
  format.ts                        table/detail rendering
  run.mjs                          cross-platform launcher package.json's "bin" points at (see "Platform support")

index.ts                    Paseo plugin entry point — pure plugin.handle()/addSurface()/addSidebarItem() registration only
                             (kept minimal: Paseo's Electron-main "evaluate" introspection pass calls this file's
                             top-level code without a real server context, so it must not directly call anything
                             imported from a .server.ts file)
main.client.tsx              session browser UI (sidebar panel): search/filter/agent tabs, List/Timeline view toggle,
                              checkboxes + bulk actions, per-provider logo icons, click-to-preview dialog with related
                              sessions, per-session and per-provider file size
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

## Platform support

Requires Node.js 22.5+ on every platform (`node:sqlite`, used for persistence, is a Node built-in that only
exists from that version onward — this is a Node-version prerequisite, not an OS-specific one).

SessionForge targets Linux, macOS, and Windows. Nothing in `src/core` depends on a specific Linux distro or
shells out to a distro's package manager — it's plain Node.js (`node:fs`, `node:path`, `node:os`,
`node:sqlite`) plus a handful of `process.platform`-dispatched pieces:

| Capability | Linux | macOS | Windows |
|---|---|---|---|
| Discover sessions (Claude Code / Codex / Gemini CLI) | `~/.claude`, `~/.codex`, `~/.gemini` (or their `*_CONFIG_DIR`/`*_HOME` env overrides) | same | same — `os.homedir()` + `node:path.join` resolve correctly on Windows too |
| SQLite persistence (`~/.sessionforge/sessionforge.db`) | `node:sqlite` (Node 22+ built-in — no native addon to prebuild per OS/arch) | same | same |
| Live-process activity signal (ACTIVE + HIGH confidence) | reads `/proc` directly | `ps` + `lsof` (both ship with macOS) | no equivalent without a native addon — falls back to timestamp-only RECENT/IDLE/STALE at MEDIUM confidence, same as GOAL.md §5 requires when there's no real evidence of a live process |
| Delete → trash (`src/core/trash.server.ts`) | freedesktop.org XDG Trash (`~/.local/share/Trash`) — the trash GNOME/KDE file managers read | `~/.Trash` — the folder Finder's Trash reads | the real Recycle Bin, via PowerShell's `Microsoft.VisualBasic.FileIO.FileSystem::DeleteFile(..., SendToRecycleBin)` — no extra dependency |
| CLI (`sessionforge <command>`, or `npm run cli --`) | works | works | works — `package.json`'s `bin` points at a plain-JS launcher (`src/cli/run.mjs`), not `bin.ts` directly, since npm's Windows shim runs the bin target through plain `node`, which can't execute TypeScript on its own |

"Linux" means any distro family — Debian/Ubuntu, RHEL/Fedora/Rocky/CentOS, Arch, etc. There's no
distro-specific code path to diverge between them; the only OS-level branching anywhere in the codebase is
`process.platform === "linux" | "darwin" | "win32"` in `activity.server.ts` and `trash.server.ts`, both
covered by tests for all three branches (`activity.server.test.ts`, `trash.server.test.ts`) — the
Linux branch is exercised for real (a real `/proc` scan against a real spawned process); macOS and Windows
are exercised by mocking `ps`/`lsof`/PowerShell's `execFile` calls with realistic output, since this
environment can't run real macOS or Windows to verify against.

## Safety model

- Adapters are **read-only** for discovery: `ClaudeCodeAdapter` only reads `~/.claude/projects/**/*.jsonl`,
  `CodexAdapter` only reads `~/.codex/state_5.sqlite` and `~/.codex/thread_history_1.sqlite` (opened with
  `{ readOnly: true }`), `GeminiCliAdapter` only reads `~/.gemini/tmp/**/chats/session-*.json` and
  `~/.gemini/projects.json`, `OpenCodeAdapter` only reads `~/.local/share/opencode/opencode.db` (also
  `{ readOnly: true }`), and `AiderAdapter` only reads `.aider.chat.history.md` files under whatever
  directories `AIDER_SEARCH_ROOTS` lists. Discovery never writes to, moves, or deletes an agent-owned
  transcript/session file.
- "Archive" and "cleanup" only change SessionForge's own `lifecycle` field in its own database
  (`ARCHIVED` / `JUNK`) — fully restorable via `sessionforge restore <id>`, nothing on disk is touched.
- The Paseo plugin's bulk "Delete selected" is the one action that does touch an agent-owned file: it moves
  it to the current OS's real trash/recycle bin (see "Platform support" above) — never a hard delete, and
  SessionForge's own record of it is dropped once that succeeds. OpenCode and Aider sessions can't be
  deleted this way: neither has a discrete per-session file (OpenCode's sessions all live as rows in one
  shared live SQLite database; Aider's share one growing per-repo markdown log), so their adapters simply
  don't implement `delete()` — attempting it reports "no delete capability" rather than risking a
  destructive edit to a file another tool is actively using.
- `cleanup` defaults to `--dry-run` (prints candidates, changes nothing). Pass `--apply` to actually trash
  the current JUNK candidates.
- Every archive/restore/cleanup/delete action is recorded in an `audit_log` table (`sessionforge audit [id]`).
- Once a session's lifecycle is explicitly set by a user action (`ARCHIVED`/`JUNK`), subsequent
  `discover` rescans will not silently flip it back — see `STICKY_LIFECYCLES` in `src/core/discover.ts`.

## Running the CLI

```bash
npm install
npm run cli -- discover              # scan Claude Code, Codex, Gemini CLI, and OpenCode session storage and populate the local index
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

Aider sessions are opt-in: set `AIDER_SEARCH_ROOTS` to a colon-separated list of directories to search
(e.g. `AIDER_SEARCH_ROOTS=~/Projects:~/Workspace npm run cli -- discover`) — with it unset, the Aider
adapter discovers nothing rather than scanning your whole filesystem by default.

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
a List/Timeline view toggle — the timeline shows duplicate/superseded badges inline — checkboxes and bulk
actions, click-to-preview dialog showing detected related sessions, ranked search, filter by recommendation,
rescan, dry-run cleanup preview with confirmation, archive/restore/delete, per-session and per-provider
on-disk size) and re-scans Claude Code, Codex, Gemini CLI, and OpenCode sessions every 5 minutes in the
background (Aider is included in that rescan too, but only once `AIDER_SEARCH_ROOTS` is set).

## MVP scope vs. GOAL.md

Implemented: Claude Code / Codex / Gemini CLI / OpenCode / Aider adapters (§3–§4; Aider is opt-in via
`AIDER_SEARCH_ROOTS`, see "Running the CLI" — it has no central session directory, unlike the other four),
ACTIVE/RECENT/IDLE/STALE activity detection with confidence (§5) — note the live-process signal in
`activity.server.ts` currently only recognizes `claude` processes, so non-Claude-Code sessions never reach
`ACTIVE`+`HIGH` confidence that way, only via timestamp heuristics — local heuristic KEEP/ARCHIVE/JUNK
classification with reason/confidence/evidence (§7), a local heuristic one-line summary per session
(§6/§22, `summarize.server.ts`; no LLM — title/first message plus the classifier's own outcome signal),
list/show/search/cleanup (dry-run + apply)/archive/restore/delete-to-trash/audit (§9–§12; delete isn't
available for OpenCode/Aider sessions — see "Safety model" above), SQLite persistence separate from
agent-owned storage (§18), FTS5-ranked search (§13 — real relevance ranking via SQLite's built-in FTS5
index, not just substring matching; see `toFtsQuery()` in `store.server.ts`), local heuristic
DUPLICATE/SUPERSEDED relationship detection (§7/§8, `relationships.server.ts` — grouped by workspace, topic
word-overlap + timing, surfaced in `session show`/the preview modal as "Related sessions" and as inline
badges in the Timeline view; informational only, never auto-mutates a session's own `lifecycle`), a
cross-agent Timeline view (§14 — day-grouped, all agents together, with relationship badges; the
List/Timeline toggle in the toolbar), a native Paseo plugin UI (§15), and Linux/macOS/Windows support (§19
— see "Platform support" above).

Deferred to Phase 2 per GOAL.md: LLM-assisted classification, and true embedding-based semantic search
(FTS5 above covers ranked lexical search; embeddings would be a separate, heavier addition).

Deferred to Phase 3 per GOAL.md: configurable/scheduled retention policies (§16, §24) — today there is only
a fixed 5-minute background rescan, no policy engine, no automatic archive-after-N-days or retention-based
delete.

### Adapter-specific notes worth knowing

- **OpenCode** (`opencode-adapter.server.ts`): reads `~/.local/share/opencode/opencode.db` directly via
  SQL (`json_extract` over each message's `role`, joined against its `part` rows for text content).
  `sizeBytes` is an approximation — the sum of that session's own message+part JSON payload sizes, since
  there's no discrete file to `stat()` and reporting the whole shared database's size for every session
  would be misleading. One real-world data quirk observed: some OpenCode versions/configs store the
  model's own title-generation meta-commentary (e.g. "Let me analyze the conversation...") in `title`
  instead of an actual generated title — passed through as-is, same "trust the source" policy as every
  other adapter; `firstUserMessage` remains reliable regardless.
- **Aider** (`aider-adapter.server.ts`): parses `.aider.chat.history.md`'s semi-structured log format
  (`# aider chat started at ...` session delimiters, `#### ` user-turn prefixes). Message/exchange counts
  are a heuristic — a user turn counts as answered if any non-blank, non-`>`-prefixed line follows it
  before the next turn — not an exact parse, since Aider's log interleaves real LLM replies with its own
  `>`-prefixed tool/warning/traceback output with no stricter structural marker between them.
  `lastActivityAt` uses the file's own mtime only for the most recent session in it (earlier ones just get
  their own start time — borrowing a later session's mtime would be misleading). The search itself skips
  hidden directories and common heavy ones (`node_modules`, `__pycache__`, `dist`, `build`) and is capped
  at 6 directories deep per search root.
