# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development

```bash
bun run build          # Bundle to dist/ (Bun bundler, target: bun) + copy config.yaml
bun run dev            # Run CLI from source
bun run link           # Build + install globally (bun link)
bun test               # Run unit tests
bun run scripts/smoke-test.ts        # Smoke test local build
bun run scripts/smoke-test.ts --remote  # Smoke test remote installation
```

Pre-push hook runs automatically: version check → build → unit tests → smoke tests. Uses **Biome** for linting, **Changesets** for versioning.

## Architecture

**Bun-first** runtime — use Bun APIs (`Bun.spawn`, `Bun.build`, `$` tag) over Node.js equivalents. No Node.js/pnpm/npm.

### Command System

Entry: `src/index.ts` — Commander.js CLI. Each command is a separate file in `src/commands/`, exporting a `new Command()` instance with `.alias()`, `.argument()`, `.option()`, `.action(async (...) => {})`. Registered via `program.addCommand()`.

Help displays all aliases sorted longest-first (custom `Help.prototype.subcommandTerm`).

### Core Modules (`src/core/`)

- **config.ts** — Loads/merges `~/.p/config.yaml` with defaults. `ensureInitialized()` creates directory structure on first run.
- **project.ts** — CRUD for projects stored in `~/.p/projects/`. Metadata in `~/.p/meta.json`.
- **template.ts** — Template system: command-based (shell commands), directory-based (copy files), or hybrid with hooks.
- **hooks.ts** — Execute hooks defined in config.yaml (`command` type for shell, `file` type for JS scripts in `~/.p/hooks/`).

### Key Utilities (`src/utils/`)

- **ui.ts** — Orange brand theme (ANSI 256: 208 primary, 214 secondary). Print helpers: `printError`, `printSuccess`, `printInfo`, `bgOrange`.
- **live-search.ts** — Custom real-time interactive search TUI (keyboard-driven, raw mode stdin).
- **project-search.ts** — Substring matching on project name/template/tags.
- **git.ts** — `removeNestedGitDirs()` clears nested `.git` dirs + gitlink entries (mode 160000) from index before push/publish.
- **shell.ts** — `execInDir()`, `execAndCapture()`, `openWithIDE()`, `commandExists()`, `moveToTrash()`.

### Storage Layout

```
~/.p/
├── config.yaml        # User config (ide, ai, hooks, templates, shortcuts)
├── meta.json          # Project metadata (template, tags, notes, dates)
├── projects/          # Project directories
├── templates/         # Local template directories (auto-discovered)
├── hooks/             # Custom hook scripts (.js)
└── templates-meta.json  # Published template tracking
```

### Unzip Cleanup (`src/commands/unzip.ts`)

`p unzip` 解压时清理 zip 文件名，规则分两层：

- **自动清理**（`autoClean`）：循环移除 `-template` 后缀 + 7-40 位十六进制哈希后缀（GitHub short SHA 到完整 SHA）。
- **公共前缀检测**（`detectCommonPrefix`）：对一组 zip 名按 dash 分 token，找最长公共 token 前缀。要求 ≥2 个名字共享、前缀 ≥3 字符、且保留至少 1 个 token 作为后缀。**不维护硬编码前缀列表**——纯靠共性推断，避免每加一个模板库都要更新代码。

CLI 选项：`-a/--auto` 跳过所有询问；`-r/--remove-prefix` / `-s/--remove-suffix` 手动指定要 strip 的前后缀（可多次，不询问）。

## Patterns

- **UI**: `@clack/prompts` for interactive prompts. Use `spinner()` for async ops — use **separate** spinner instances per step (reuse causes rendering artifacts). `intro()`/`outro()` for section framing.
- **Error flow**: `printError()` + `process.exit(1)`.
- **Git helper**: Inline `async function git(args, cwd)` using `Bun.spawn` in commands that need git operations.
- **Nested .git cleanup**: Always call `removeNestedGitDirs()` before `git add` in push/publish to prevent gitlink references.
- **Config editing**: Only `ensureInitialized` copies config.yaml on first run — never overwrite user's existing config.

## Cursor Rules

- Use `bun` not `node`/`npm`/`pnpm`. Prefer Bun file system APIs over `fs-extra`.
- Test with `bun test`.
