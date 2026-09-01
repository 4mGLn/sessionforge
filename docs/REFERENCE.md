# SessionForge Reference

Architecture, repo layout, and implementation-level detail. For how to actually *use* SessionForge, see
[`MANUAL.md`](MANUAL.md). For contributing/dev workflow, see [`../CONTRIBUTING.md`](../CONTRIBUTING.md).

## Contents

- [Layout](#layout)
- [Why a plugin *and* a CLI — and why they're separate packages](#why-a-plugin-and-a-cli--and-why-theyre-separate-packages)
- [MVP scope vs. GOAL.md](#mvp-scope-vs-goalmd)
- [Adapter-specific notes worth knowing](#adapter-specific-notes-worth-knowing)

## Layout

```
packages/cli/                      sessionforge — the standalone package, zero Paseo dependency (own README)
  src/index.ts                     public library export surface (what `import ... from "sessionforge"` gets)
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
    run.mjs                        cross-platform launcher package.json's "bin" points at (see MANUAL.md's Platform support)
  dist/                            compiled output (git-ignored) — the actual import target for library consumers,
                                    built via `npm run build`; the CLI itself runs off raw TS via tsx, no build needed

src/server/                        Paseo plugin RPC layer — depends on sessionforge like any npm package
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
`packages/cli` / `sessionforge`, takes that one step further: nothing in it imports `@getpaseo/*`,
`react`, or `react-native`, so it's independently publishable and useful to anyone who never touches Paseo.
The repo root — `index.ts`, `main.client.tsx`, `src/server/*` — is just the Paseo plugin, depending on
`sessionforge` the same way any other npm consumer would (a workspace-local dependency during
development, a normal semver dependency once published).

`packages/cli` builds a real `dist/` (compiled JS + `.d.ts`) as its library entry point rather than shipping
raw TypeScript for that path, specifically so the plugin's cross-package import (`import ... from
"sessionforge"`) resolves through completely standard `node_modules` resolution — no assumption that
Paseo's own plugin loader can handle TypeScript reached via a package boundary, only that it can load a
plain compiled `.js` file the same as any other npm dependency. The CLI binary itself still runs off raw
TypeScript via `tsx` — that path was already proven working before the package split and didn't need to
change.

## MVP scope vs. GOAL.md

Implemented: Claude Code / Codex / Gemini CLI / OpenCode / Aider adapters (§3–§4; Aider is opt-in via
`AIDER_SEARCH_ROOTS` — it has no central session directory, unlike the other four), ACTIVE/RECENT/IDLE/STALE
activity detection with confidence (§5) — note the live-process signal in `activity.server.ts` currently
only recognizes `claude` processes, so non-Claude-Code sessions never reach `ACTIVE`+`HIGH` confidence that
way, only via timestamp heuristics — local heuristic KEEP/ARCHIVE/JUNK classification with
reason/confidence/evidence (§7), a local heuristic one-line summary per session (§6/§22,
`summarize.server.ts`; no LLM — title/first message plus the classifier's own outcome signal),
list/show/search/cleanup (dry-run + apply)/archive/restore/delete-to-trash/audit (§9–§12; delete isn't
available for OpenCode/Aider sessions — see MANUAL.md's Safety model), SQLite persistence separate from
agent-owned storage (§18), FTS5-ranked search (§13 — real relevance ranking via SQLite's built-in FTS5
index, not just substring matching; see `toFtsQuery()` in `store.server.ts`), local heuristic
DUPLICATE/SUPERSEDED relationship detection (§7/§8, `relationships.server.ts` — grouped by workspace, topic
word-overlap + timing, surfaced in `session show`/the preview modal as "Related sessions" and as inline
badges in the Timeline view; informational only, never auto-mutates a session's own `lifecycle`), a
cross-agent Timeline view (§14 — day-grouped, all agents together, with relationship badges and the same
per-row checkbox/Archive-Restore and bulk-selection support as the List view, sharing one selection-state
model between both), a native Paseo plugin UI (§15), Linux/macOS/Windows support (§19 — see MANUAL.md's
Platform support), and CI + a publish-ready, independently-usable CLI package (§19's "be installable" — now
true two ways: `paseo plugin install`, or `npm install -g sessionforge`).

Deferred to Phase 2 per GOAL.md: LLM-assisted classification, and true embedding-based semantic search
(FTS5 above covers ranked lexical search; embeddings would be a separate, heavier addition).

Deferred to Phase 3 per GOAL.md: configurable/scheduled retention policies (§16, §24) — today there is only
a fixed 5-minute background rescan, no policy engine, no automatic archive-after-N-days or retention-based
delete.

## Adapter-specific notes worth knowing

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
