# SessionForge Manual

How to actually use SessionForge — the CLI, the Paseo plugin, and the safety guarantees behind both. For
architecture/internals see [`REFERENCE.md`](REFERENCE.md); for the standalone package's own quick reference
see [`packages/cli/README.md`](../packages/cli/README.md).

## Contents

- [CLI reference](#cli-reference)
- [Installing the standalone binary](#installing-the-standalone-binary)
- [Aider (opt-in) setup](#aider-opt-in-setup)
- [Installing the Paseo plugin](#installing-the-paseo-plugin)
- [Safety model](#safety-model)
- [Platform support](#platform-support)

## CLI reference

```bash
sessionforge discover                      # scan agent-owned storage and refresh the local index
sessionforge list [flags]                  # list sessions
sessionforge show <id> [--json]            # show one session in detail, including related sessions
sessionforge search <query> [--json]       # FTS5-ranked full-text search across title/summary/project
sessionforge cleanup [--apply] [--json]    # preview (default) or apply junk cleanup
sessionforge archive <id> [--reason ...]   # move a session out of the active view
sessionforge restore <id> [--reason ...]   # bring an archived/trashed session back
sessionforge audit [id] [--json]           # show the audit trail for destructive operations
```

`list` flags: `--agent`, `--project`, `--status`, `--lifecycle`, `--category`, `--older-than 30d`,
`--query`, `--scan` (run a fresh discover before listing), `--json`.

From a clone of this repo (rather than a global `sessionforge-cli` install), prefix every command with
`npm run cli --`, e.g. `npm run cli -- discover`. For scripting/automation, add npm's `--silent` flag so
its own banner doesn't leak into piped output: `npm run --silent cli -- list --json | jq .`.

All state lives in one SQLite database, `~/.sessionforge/sessionforge.db` — separate from every agent's
own storage. The CLI and the Paseo plugin share this same database, so `sessionforge archive <id>` from a
terminal is reflected immediately in the Paseo UI panel, and vice versa.

## Installing the standalone binary

For a machine with no Node.js installed, `sessionforge` also ships as a self-contained native binary (via
Node's [Single Executable Application](https://nodejs.org/api/single-executable-applications.html) support
— the whole Node runtime is embedded, so the binary is large (~100MB+) but has zero runtime dependencies,
the same tradeoff `deno compile`/`bun build --compile` make):

```bash
curl -fsSL https://raw.githubusercontent.com/4mGLn/sessionforge/main/install.sh | sh
```

```powershell
irm https://raw.githubusercontent.com/4mGLn/sessionforge/main/install.ps1 | iex
```

Each downloads the right prebuilt binary for your OS/arch from the
[latest GitHub Release](https://github.com/4mGLn/sessionforge/releases/latest) and installs it to a
user-local directory (`~/.local/bin` on Linux/macOS, `%USERPROFILE%\.sessionforge\bin` on Windows by
default — no `sudo`/admin privileges needed), printing a PATH hint if that directory isn't already on it.
Override the install location with `SESSIONFORGE_INSTALL_DIR` (`install.sh`) or
`$env:SESSIONFORGE_INSTALL_DIR` (`install.ps1`).

Published targets: `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`, `x86_64-apple-darwin` (Intel),
`aarch64-apple-darwin` (Apple Silicon), `x86_64-pc-windows-msvc`. Built natively per target in
[`.github/workflows/release.yml`](../.github/workflows/release.yml) — SEA binaries aren't cross-compilable,
so each runs on its own matching GitHub Actions runner OS.

Once installed, `sessionforge` behaves identically to the npm-installed CLI — same commands, same shared
`~/.sessionforge/sessionforge.db`.

## Aider (opt-in) setup

Aider has no central session directory the way the other four tools do — it appends to a
`.aider.chat.history.md` file directly in whatever project directory it was launched from, and nothing in
Aider's own global state tracks which directories that is. So the Aider adapter only searches directories
you explicitly list:

```bash
AIDER_SEARCH_ROOTS=~/Projects:~/Workspace sessionforge discover
```

Delimited the same way `PATH` is on your OS — `:` on Linux/macOS, `;` on Windows (e.g.
`AIDER_SEARCH_ROOTS=C:\Projects;C:\Workspace`). With it unset, Aider sessions are simply never discovered —
no default whole-filesystem scan.

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

Once installed, the plugin registers a "SessionForge" sidebar item: an agent-tabbed session browser with a
List/Timeline view toggle (the timeline shows duplicate/superseded badges inline), checkboxes and bulk
actions in both views, a click-to-preview dialog showing detected related sessions, ranked search, filter
by recommendation, rescan, dry-run cleanup preview with confirmation, archive/restore/delete, and
per-session/per-provider on-disk size. It re-scans Claude Code, Codex, Gemini CLI, and OpenCode sessions
every 5 minutes in the background (Aider is included in that rescan too, but only once
`AIDER_SEARCH_ROOTS` is set).

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

## Platform support

Requires Node.js 22.16+ on every platform (`node:sqlite`, used for persistence, is a Node built-in — but it
needs the `--experimental-sqlite` flag before Node 22.13, and its FTS5 support, which the search feature
depends on, isn't compiled in until 22.16 — verified empirically across the 22.x line, not just read off
release notes. This is a Node-version prerequisite, not an OS-specific one).

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
`packages/cli/src/core/`). CI runs the full suite on real Linux, macOS, and Windows runners on every push —
the Linux branch is additionally exercised locally for real (a real `/proc` scan against a real spawned
process), while macOS/Windows are covered locally by mocking `ps`/`lsof`/PowerShell's `execFile` with
realistic output.
