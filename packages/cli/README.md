# sessionforge

Discover, classify, search, and safely clean up agent coding sessions — Claude Code, Codex, Gemini CLI,
OpenCode, and Aider — from the command line or as a library. No Paseo dependency: this package is the
standalone engine behind the [SessionForge Paseo plugin](../../README.md), but works entirely on its own.

## Install

Not published to npm (this package is `"private": true`) — the CLI is distributed as a standalone binary
instead:

```bash
curl -fsSL https://raw.githubusercontent.com/4mGLn/sessionforge/main/install.sh | sh
```

See the [root README](../../README.md#install) for the Windows one-liner and for installing the Paseo
plugin. Requires Node.js 22.16+ only if you're building/running from source instead of the binary (uses
`node:sqlite` — needs the `--experimental-sqlite` flag before Node 22.13, and its FTS5 support, which
search depends on, isn't compiled in until 22.16).
Works on Linux (any distro), macOS (Intel and Apple Silicon), and Windows — see the root repo's
[Platform support](../../README.md#platform-support) section for the per-OS details (trash/recycle-bin
handling, live-process activity detection, etc.), which all live in this package.

## CLI usage

```bash
sessionforge discover              # scan Claude Code, Codex, Gemini CLI, and OpenCode session storage
sessionforge list                  # table view; add --json for machine-readable output
sessionforge list --category junk --older-than 30d
sessionforge show <session-id>
sessionforge search "postgresql"
sessionforge cleanup               # dry run (default) — nothing changes
sessionforge cleanup --apply       # move current JUNK candidates to trash (still restorable)
sessionforge archive <session-id> --reason "done"
sessionforge restore <session-id>
sessionforge audit [session-id]
sessionforge wire-paseo            # download and install the Paseo plugin
sessionforge paseo-status          # plugin install/running status and version drift
sessionforge check-update          # check for a newer release
sessionforge update                # download and install the latest release, replacing this binary
```

Every command other than `check-update`/`update`/`--version` does a cached (once per 24h),
silently-fails-safe background check for a newer release and prints a one-line notice if one's available —
see the root [MANUAL.md](../../docs/MANUAL.md#staying-up-to-date) for details.

Aider sessions are opt-in: set `AIDER_SEARCH_ROOTS` to a list of directories to search, delimited the same
way `PATH` is on your OS (`:` on Linux/macOS, `;` on Windows) — Aider has no central session directory,
unlike the other four tools — e.g.:

```bash
AIDER_SEARCH_ROOTS=~/Projects:~/Workspace sessionforge discover
```

All state lives in `~/.sessionforge/sessionforge.db` (SQLite) — separate from every agent's own storage;
nothing here ever writes to, moves, or deletes an agent-owned transcript file except the one explicit,
user-confirmed exception: `archive`/`cleanup --apply` only ever change this database's own `lifecycle`
field, and deletion moves a file to the OS's real trash/recycle bin, never a hard delete (and isn't
available at all for OpenCode/Aider sessions, which have no isolatable per-session file to move safely).

## Library usage

Everything the CLI does is also a plain function/class export — no Paseo, no RPC layer. Since this package
isn't published, this only works as a workspace-local import from elsewhere in this same monorepo (which is
exactly how the Paseo plugin itself consumes it — see `src/server/session-handlers.server.ts`):

```ts
import { SessionStore, ClaudeCodeAdapter, CodexAdapter, runDiscovery } from "@aadaa88/sessionforge";

const store = new SessionStore(); // defaults to ~/.sessionforge/sessionforge.db
await runDiscovery(store, [new ClaudeCodeAdapter(), new CodexAdapter()]);
const sessions = store.listSessions({ query: "postgresql vacuum" }); // FTS5-ranked search
store.close();
```

See `src/index.ts` for the full export surface: adapters (`ClaudeCodeAdapter`, `CodexAdapter`,
`GeminiCliAdapter`, `OpenCodeAdapter`, `AiderAdapter`), `SessionStore`, `runDiscovery`, `classifySession`,
`summarizeSession`, `detectActivity`, `detectRelationships`, `archiveSession`/`restoreSession`/
`deleteSession(s)`/`runCleanup`, `moveToTrash`, and every `Session`/`SessionFilter`/etc. type.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run — classifier/adapter/store/relationship unit tests + a real /proc-based
                     # activity-detection integration test on Linux
npm run build        # tsc -p tsconfig.build.json — emits dist/ (the library entry point other packages,
                      # including the Paseo plugin in this same repo, actually import)
npm run cli -- <command>   # run the CLI against local TypeScript source via tsx, no build needed
```

## License

[MIT](LICENSE) © aMgLn
