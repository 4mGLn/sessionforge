# SessionForge

[![CI](https://github.com/4mGLn/sessionforge/actions/workflows/ci.yml/badge.svg)](https://github.com/4mGLn/sessionforge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) | **한국어**

Claude Code, Codex, Gemini CLI, OpenCode, Aider 등 여러 코딩 에이전트의 세션을 탐색하고 분류하며 안전하게
정리하는 도구입니다 — KEEP / ARCHIVE / JUNK 휴리스틱 분류기, 순위 기반 검색, 중복·대체 세션 탐지, 에이전트를
가로지르는 날짜별 타임라인까지, 다섯 개 도구가 제각각 흩어놓은 저장 형식 대신 하나의 로컬 SQLite
데이터베이스로 모두 관리합니다.

**Paseo 전용이 아닙니다.** [`packages/cli`](packages/cli/README.md) (`sessionforge`)는 Paseo/React
의존성이 전혀 없는 독립 엔진으로, 어떤 Node 프로젝트에서도 CLI나 라이브러리로 사용할 수 있습니다. 저장소
루트는 이 엔진에 의존하는 하나의 Paseo 플러그인일 뿐입니다. 둘 중 하나만 써도, 둘 다 써도 되며 — 같은 로컬
데이터베이스를 공유합니다.

## 시작하기

```bash
git clone https://github.com/4mGLn/sessionforge.git
cd sessionforge
npm install                          # 워크스페이스(두 패키지 모두) 설정
npm run cli -- discover              # Claude Code/Codex/Gemini CLI/OpenCode 세션 저장소 스캔
npm run cli -- list                  # 표 형태로 출력; --json을 붙이면 기계가 읽기 좋은 형식
npm run cli -- search "postgresql"   # FTS5 기반 순위 검색
```

Paseo 없이도 위 과정을 그대로 사용할 수 있습니다. 전체 CLI 레퍼런스, Aider의 옵트인 설정, Paseo 플러그인
설치 방법은 [`docs/MANUAL.md`](docs/MANUAL.md)를 참고하세요.

## 설치

**Node.js 없이 바로 실행되는 독립 바이너리** (Linux, macOS, Windows):

```bash
curl -fsSL https://raw.githubusercontent.com/4mGLn/sessionforge/main/install.sh | sh
```

```powershell
irm https://raw.githubusercontent.com/4mGLn/sessionforge/main/install.ps1 | iex
```

최신 [GitHub Release](https://github.com/4mGLn/sessionforge/releases)에서 사용 중인 플랫폼에 맞는
`sessionforge` 바이너리를 내려받아 PATH에 등록합니다. 지원 대상과 설치 경로를 바꾸는 방법은
[`docs/MANUAL.md`](docs/MANUAL.md#installing-the-standalone-binary)를 참고하세요.

다른 설치 방법:

- **npm으로 CLI 설치:** 배포된 뒤에는 `npm install -g @aadaa88/sessionforge` — 자세한 내용은
  [`packages/cli/README.md`](packages/cli/README.md) 참고.
- **Paseo 플러그인:** 클론한 뒤 `paseo plugin install /path/to/sessionforge` — 자세한 내용과 알려진 환경
  이슈는 [`docs/MANUAL.md`](docs/MANUAL.md#installing-the-paseo-plugin) 참고.
- npm·플러그인 경로는 **Node.js 22.16 이상**이 필요합니다 (독립 바이너리는 Node.js가 전혀 필요 없습니다).
  Linux(모든 배포판), macOS(Intel 또는 Apple Silicon), Windows에서 동작합니다.

## 문서

- [`docs/MANUAL.md`](docs/MANUAL.md) — 전체 CLI 레퍼런스, Aider 설정, Paseo 플러그인 설치, 안전 모델,
  플랫폼별 동작 방식.
- [`docs/REFERENCE.md`](docs/REFERENCE.md) — 아키텍처, 저장소 구조, 패키지가 두 개로 나뉜 이유,
  [`GOAL.md`](../GOAL.md) 대비 스펙 추적, 어댑터 구현 참고 사항.
- [`packages/cli/README.md`](packages/cli/README.md) — 독립 패키지 자체의 간단한 레퍼런스(CLI + 라이브러리
  사용법)로, 이 저장소를 클론하지 않고 `sessionforge`만 설치했다면 이 문서를 보면 됩니다.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — 개발 환경 설정, 테스트, CI, 배포 과정.

## 라이선스

[MIT](LICENSE) © aMgLn
