# SessionForge

[![CI](https://github.com/4mGLn/sessionforge/actions/workflows/ci.yml/badge.svg)](https://github.com/4mGLn/sessionforge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**English** | [한국어](README.ko.md)

Discovers, classifies, and safely cleans up agent coding sessions across **Claude Code, Codex, Gemini CLI,
OpenCode, and Aider** — a KEEP / ARCHIVE / JUNK heuristic classifier, ranked search, duplicate/superseded
detection, and a day-grouped cross-agent timeline, all backed by one local SQLite database instead of five
different tools' scattered storage formats.

**Not Paseo-only.** [`packages/cli`](packages/cli/README.md) (`sessionforge`) is the standalone engine
— zero Paseo/React dependency, usable as a CLI or a library in any Node project. The repo root is a Paseo
plugin that depends on it like any other npm package. Use either one, or both — they share the same local
database.

## Getting started

```bash
git clone https://github.com/4mGLn/sessionforge.git
cd sessionforge
npm install                          # sets up the workspace (both packages)
npm run cli -- discover              # scans Claude Code/Codex/Gemini CLI/OpenCode session storage
npm run cli -- list                  # table view; add --json for machine-readable output
npm run cli -- search "postgresql"   # FTS5-ranked search
```

No Paseo required for any of that. See [`docs/MANUAL.md`](docs/MANUAL.md) for the full CLI reference,
Aider's opt-in setup, and installing the Paseo plugin.

## Install

**Standalone binary, no Node.js required** (Linux, macOS, Windows):

```bash
curl -fsSL https://raw.githubusercontent.com/4mGLn/sessionforge/main/install.sh | sh
```

```powershell
irm https://raw.githubusercontent.com/4mGLn/sessionforge/main/install.ps1 | iex
```

Downloads a prebuilt `sessionforge` binary for your platform from the latest
[GitHub Release](https://github.com/4mGLn/sessionforge/releases) and puts it on your PATH. See
[`docs/MANUAL.md`](docs/MANUAL.md#installing-the-standalone-binary) for supported targets and override options.

Also available as a **Paseo plugin**: `paseo plugin install /path/to/sessionforge` after cloning — see
[`docs/MANUAL.md`](docs/MANUAL.md#installing-the-paseo-plugin) for details and a known environment quirk
(this route needs Node.js 22.16+; the standalone binary needs no Node.js at all).

Not published to npm — the standalone binary and the Paseo plugin are the only distribution channels.

## Documentation

- [`docs/MANUAL.md`](docs/MANUAL.md) — full CLI reference, Aider setup, Paseo plugin install, the safety
  model, and per-platform behavior.
- [`docs/REFERENCE.md`](docs/REFERENCE.md) — architecture, repo layout, why it's two packages, spec
  tracking against [`GOAL.md`](../GOAL.md), and adapter implementation notes.
- [`packages/cli/README.md`](packages/cli/README.md) — the standalone package's own quick reference (CLI +
  library usage).
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — dev setup, testing, and CI.

## License

[MIT](LICENSE) © aMgLn
