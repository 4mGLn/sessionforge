# SessionForge

[![CI](https://github.com/4mGLn/sessionforge/actions/workflows/ci.yml/badge.svg)](https://github.com/4mGLn/sessionforge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Discovers, classifies, and safely cleans up agent coding sessions across Claude Code, Codex, Gemini CLI,
OpenCode, and Aider, with a KEEP / ARCHIVE / JUNK heuristic classifier. See [`../GOAL.md`](../GOAL.md) for
the full product spec this implements against.

**This is not Paseo-only.** The repo is a two-package npm workspace:
[`packages/cli`](packages/cli/README.md) (published as `sessionforge-cli`) is the actual engine —
adapters, classification, search, persistence — with **zero Paseo/React dependency**, usable standalone
(`npm install -g sessionforge-cli`, or as a library import in any Node project). The repo root is the
Paseo plugin, a thin RPC/UI layer that depends on `sessionforge-cli` like any other npm package. Both talk
to the same local SQLite database (`~/.sessionforge/sessionforge.db`), so `sessionforge archive <id>` from
a terminal — with or without Paseo installed at all — is reflected immediately in the Paseo UI panel, if
you happen to be running it, and vice versa.

## Contents

- [Quick start](#quick-start)
- [Layout](#layout)
- [Why a plugin *and* a CLI — and why they're separate packages](#why-a-plugin-and-a-cli--and-why-theyre-separate-packages)
- [Platform support](#platform-support)
- [Safety model](#safety-model)
- [Installing the Paseo plugin](#installing-the-paseo-plugin)
- [Development](#development)
- [MVP scope vs. GOAL.md](#mvp-scope-vs-goalmd)
- [License](#license)

## Quick start

```bash
git clone https://github.com/4mGLn/sessionforge.git
cd sessionforge
npm install                          # sets up the workspace — both packages
npm run cli -- discover              # scans Claude Code/Codex/Gemini CLI/OpenCode session storage
npm run cli -- list                  # table view; add --json for machine-readable output
npm run cli -- search "postgresql"   # FTS5-ranked search
```

No Paseo required for any of that. Once `sessionforge-cli` is published, `npm install -g sessionforge-cli`
gives the same `sessionforge` command with no repo checkout at all — see
[`packages/cli/README.md`](packages/cli/README.md) for the full CLI reference, `AIDER_SEARCH_ROOTS`, and
library (`import ... from "sessionforge-cli"`) usage. To use it *with* Paseo instead of (or alongside) the
CLI, see [Installing the Paseo plugin](#installing-the-paseo-plugin).

## Layout

```
packages/cli/                      sessionforge-cli — the standalone package, zero Paseo dependency (own README)
  src/index.ts                     public library export surface (what `import ... from "sessionforge-cli"` gets)
  src/core/                        agent-agnostic domain logic
    types.server.ts                Session / Classification / Adapter interfaces
    claude-transcript.server.ts    streams a single Claude Code .jsonl transcript
    claude-adapter.server.ts       discovers all Claude Code sessions on disk (read-only)
    codex-adapter.server.ts        reads Codex's ~/.codex/state_5.sqlite + thread_history_1.sqlite (read-only)
    gemini-adapter.server.ts       reads Gemini CLI's ~/.gemini/tmp/**/chats/session-*.json (read-only)
    opencode-adapter.server.ts     reads OpenCode's ~/.local/share/opencode/opencode.db (read-only; no delete() —
                                    every session shares one live SQLite db, no discrete per-session file to move)
    aider-adapter.server.ts        parses .aider.chat.history.md files found under AIDER_SEARCH_ROOTS (opt-in,
                                    unset by default — Aider has no central session directory to read); no delete()
                                    either, since sessions share one growing per-repo log file
    text-utils.server.ts           capFirstMessage() etc. — caps oversized transcript fields before they hit the RPC transport
    activity.server.ts             ACTIVE/RECENT/IDLE/STALE detection with confidence
    classify.server.ts             KEEP/ARCHIVE/JUNK heuristic classifier
    summarize.server.ts            local heuristic one-line "concise summary" (title/first-message + classifier outcome, no LLM)
    relationships.server.ts        local heuristic DUPLICATE/SUPERSEDED cross-session detection (same workspace, topic word-overlap, timing)
    trash.server.ts                OS-dispatched move-to-trash for delete (Linux XDG Trash / macOS ~/.Trash / Windows Recycle Bin)
    store.server.ts                SQLite persistence + FTS5 ranked search (node:sqlite, ~/.sessionforge/sessionforge.db)
    discover.server.ts             orchestrates adapters -> activity -> classify -> summarize -> store -> relationships
    lifecycle-actions.server.ts    archive/restore/delete/cleanup + audit log
  src/cli/                         the `sessionforge` CLI itself, imports ../core directly — no daemon needed
    bin.ts                         command dispatch
    format.ts                      table/detail rendering
    run.mjs                        cross-platform launcher package.json's "bin" points at (see "Platform support")
  dist/                            compiled output (git-ignored) — the actual import target for library consumers,
                                    built via `npm run build`; the CLI itself runs off raw TS via tsx, no build needed

src/server/                        Paseo plugin RPC layer — depends on sessionforge-cli like any npm package
  session-contracts.shared.ts      Zod RPC contracts (session.list, .show, .search, .cleanup, .archive, .restore, .delete, .discover)
  session-handlers.server.ts       handler implementations + background rescan scheduling (ADAPTERS = Claude Code, Codex, Gemini CLI, OpenCode, Aider)

index.ts                    Paseo plugin entry point — pure plugin.handle()/addSurface()/addSidebarItem() registration only
                             (kept minimal: Paseo's Electron-main "evaluate" introspection pass calls this file's
                             top-level code without a real server context, so it must not directly call anything
                             imported from a .server.ts file)
main.client.tsx              session browser UI (sidebar panel): search/filter/agent tabs, List/Timeline view toggle,
                              checkboxes + bulk actions, per-provider logo icons, click-to-preview dialog with related
                              sessions, per-session and per-provider file size

.github/workflows/           CI (typecheck/test/build on Linux/macOS/Windows) + a manual-trigger npm publish workflow
```

## Why a plugin *and* a CLI — and why they're separate packages

Paseo's plugin SDK (`@getpaseo/plugin`) has no mechanism for registering `paseo` subcommands — only RPC
handlers and native UI surfaces (sidebar items, workspace panels, Command Center items). GOAL.md's
`paseo session list`-style CLI examples aren't achievable literally inside a plugin, so a standalone CLI
was always necessary. Splitting that CLI (plus the whole engine underneath it) into its own package,
`packages/cli` / `sessionforge-cli`, takes that one step further: nothing in it imports `@getpaseo/*`,
`react`, or `react-native`, so it's independently publishable and useful to anyone who never touches Paseo.
The repo root — `index.ts`, `main.client.tsx`, `src/server/*` — is just the Paseo plugin, depending on
`sessionforge-cli` the same way any other npm consumer would (a workspace-local dependency during
development, a normal semver dependency once published).

## Platform support

Requires Node.js 22.5+ on every platform (`node:sqlite`, used for persistence, is a Node built-in that only
exists from that version onward — this is a Node-version prerequisite, not an OS-specific one).

SessionForge targets Linux, macOS, and Windows. Nothing in `packages/cli/src/core` depends on a specific
Linux distro or shells out to a distro's package manager — it's plain Node.js (`node:fs`, `node:path`,
`node:os`, `node:sqlite`) plus a handful of `process.platform`-dispatched pieces:

| Capability | Linux | macOS | Windows |
|---|---|---|---|
| Discover sessions (Claude Code / Codex / Gemini CLI) | `~/.claude`, `~/.codex`, `~/.gemini` (or their `*_CONFIG_DIR`/`*_HOME` env overrides) | same | same — `os.homedir()` + `node:path.join` resolve correctly on Windows too |
| SQLite persistence (`~/.sessionforge/sessionforge.db`) | `node:sqlite` (Node 22+ built-in — no native addon to prebuild per OS/arch) | same | same |
| Live-process activity signal (ACTIVE + HIGH confidence) | reads `/proc` directly | `ps` + `lsof` (both ship with macOS) | no equivalent without a native addon — falls back to timestamp-only RECENT/IDLE/STALE at MEDIUM confidence, same as GOAL.md §5 requires when there's no real evidence of a live process |
| Delete → trash (`packages/cli/src/core/trash.server.ts`) | freedesktop.org XDG Trash (`~/.local/share/Trash`) — the trash GNOME/KDE file managers read | `~/.Trash` — the folder Finder's Trash reads | the real Recycle Bin, via PowerShell's `Microsoft.VisualBasic.FileIO.FileSystem::DeleteFile(..., SendToRecycleBin)` — no extra dependency |
| CLI (`sessionforge <command>`, or `npm run cli --`) | works | works | works — `package.json`'s `bin` points at a plain-JS launcher (`src/cli/run.mjs`), not `bin.ts` directly, since npm's Windows shim runs the bin target through plain `node`, which can't execute TypeScript on its own |

"Linux" means any distro family — Debian/Ubuntu, RHEL/Fedora/Rocky/CentOS, Arch, etc. There's no
distro-specific code path to diverge between them; the only OS-level branching anywhere in the codebase is
`process.platform === "linux" | "darwin" | "win32"` in `activity.server.ts` and `trash.server.ts` (both in
`packages/cli/src/core/`). CI (see [Development](#development)) runs the full suite on real Linux, macOS,
and Windows runners on every push — the Linux branch is additionally exercised locally for real (a real
`/proc` scan against a real spawned process), while macOS/Windows are covered locally by mocking
`ps`/`lsof`/PowerShell's `execFile` with realistic output.

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
- Bulk "Delete selected" is the one action that does touch an agent-owned file: it moves it to the current
  OS's real trash/recycle bin (see [Platform support](#platform-support)) — never a hard delete, and
  SessionForge's own record of it is dropped once that succeeds. OpenCode and Aider sessions can't be
  deleted this way: neither has a discrete per-session file (OpenCode's sessions all live as rows in one
  shared live SQLite database; Aider's share one growing per-repo markdown log), so their adapters simply
  don't implement `delete()` — attempting it reports "no delete capability" rather than risking a
  destructive edit to a file another tool is actively using.
- `cleanup` defaults to `--dry-run` (prints candidates, changes nothing). Pass `--apply` to actually trash
  the current JUNK candidates.
- Every archive/restore/cleanup/delete action is recorded in an `audit_log` table (`sessionforge audit [id]`).
- Once a session's lifecycle is explicitly set by a user action (`ARCHIVED`/`JUNK`), subsequent
  `discover` rescans will not silently flip it back — see `STICKY_LIFECYCLES` in
  `packages/cli/src/core/discover.server.ts`.

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

## Development

```bash
npm install          # workspace install — both packages
npm run typecheck     # tsc --noEmit at the root, then in packages/cli
npm test              # delegates to packages/cli's vitest suite
npm run build          # builds packages/cli's dist/ (the library entry point the plugin imports)
npm run cli -- <command>   # delegates to packages/cli's CLI, run from local TypeScript via tsx
```

`npm test` runs classifier/adapter/store/relationship heuristics, FTS5 search, a real `/proc`-based
activity-detection integration test on Linux, and an end-to-end discover -> classify -> cleanup/archive/
restore -> rescan-doesn't-clobber-lifecycle flow against temp fixtures and a temp SQLite db.

**CI** (`.github/workflows/ci.yml`) runs `typecheck`/`test`/`build` plus a CLI-binary smoke test on a
Linux/macOS/Windows matrix, and a separate job pinned to the `engines.node` floor (22.5.0) so a drift in
"latest 22.x" can't quietly hide a floor-version regression.

**Publishing** (`.github/workflows/publish.yml`) is manual-trigger only (`workflow_dispatch`) — it never
runs on a push, and it needs an `NPM_TOKEN` repo secret (an npm automation token with publish rights)
configured before it can succeed. It publishes `packages/cli` with `--provenance`, which requires the repo
to stay public.

## MVP scope vs. GOAL.md

Implemented: Claude Code / Codex / Gemini CLI / OpenCode / Aider adapters (§3–§4; Aider is opt-in via
`AIDER_SEARCH_ROOTS` — it has no central session directory, unlike the other four), ACTIVE/RECENT/IDLE/STALE
activity detection with confidence (§5) — note the live-process signal in `activity.server.ts` currently
only recognizes `claude` processes, so non-Claude-Code sessions never reach `ACTIVE`+`HIGH` confidence that
way, only via timestamp heuristics — local heuristic KEEP/ARCHIVE/JUNK classification with
reason/confidence/evidence (§7), a local heuristic one-line summary per session (§6/§22,
`summarize.server.ts`; no LLM — title/first message plus the classifier's own outcome signal),
list/show/search/cleanup (dry-run + apply)/archive/restore/delete-to-trash/audit (§9–§12; delete isn't
available for OpenCode/Aider sessions — see [Safety model](#safety-model)), SQLite persistence separate
from agent-owned storage (§18), FTS5-ranked search (§13 — real relevance ranking via SQLite's built-in FTS5
index, not just substring matching; see `toFtsQuery()` in `store.server.ts`), local heuristic
DUPLICATE/SUPERSEDED relationship detection (§7/§8, `relationships.server.ts` — grouped by workspace, topic
word-overlap + timing, surfaced in `session show`/the preview modal as "Related sessions" and as inline
badges in the Timeline view; informational only, never auto-mutates a session's own `lifecycle`), a
cross-agent Timeline view (§14 — day-grouped, all agents together, with relationship badges and the same
per-row checkbox/Archive-Restore and bulk-selection support as the List view, sharing one selection-state
model between both), a native Paseo plugin UI (§15), Linux/macOS/Windows support (§19 — see
[Platform support](#platform-support)), and CI + a publish-ready, independently-usable CLI package (§19's
"be installable" — now true two ways: `paseo plugin install`, or `npm install -g sessionforge-cli`).

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

## License

[MIT](LICENSE) © aMgLn — see [`packages/cli`](packages/cli/README.md) for the standalone engine's own
copy of the same license.
