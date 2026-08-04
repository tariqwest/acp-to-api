# AGENTS.md

Documentation for AI coding agents working on `acp-to-api`.

## Overview

`acp-to-api` is an OpenAI-compatible REST gateway for local [Agent Client Protocol (ACP)](https://agentclientprotocol.com) agents. It translates standard OpenAI `/v1/chat/completions` and `/v1/models` HTTP requests into ACP stdio sessions.

```text
OpenAI Client → Hono Gateway (/v1/*) → Session Pool → ACP stdio agent (e.g., opencode, claude, devin)
```

## Repository Architecture

```text
src/
├── index.ts               # Entry point: handles CLI subcommands (`init`) and starts Hono server
├── init.ts                # `acp-to-api init`: auto-detects installed ACP binaries and generates config.toml
├── init.test.ts           # Unit tests for initialization module
├── server.ts              # Hono REST application routes (/v1/models, /v1/chat/completions, /health)
├── config.ts              # Configuration loader ($XDG_CONFIG_HOME/acp-to-api/config.toml & default.json)
├── config.test.ts         # Unit tests for config loading and normalization
├── types.ts               # Core TypeScript interfaces (AppConfig, AgentConfig, Session, etc.)
├── acp/
│   ├── catalog.ts         # Model catalog with background discovery and disk caching
│   ├── client.ts          # ACP stdio client wrapper over `@agentclientprotocol/sdk`
│   └── pool.ts            # Session pool with global and per-agent concurrency limits
├── adapters/
│   ├── registry.ts        # Agent registry, command resolution, and alias lookup
│   └── registry.test.ts   # Unit tests for agent registry resolution
├── openai/
│   └── schema.ts          # Zod request/response validation and SSE chunk formatting
└── util/
    ├── messages.ts        # Message formatting, path extraction, and workspace cwd resolution
    ├── messages.test.ts   # Unit tests for messages utility and resolveCwd
    └── permissions.ts     # ACP permission handler (`auto_allow`, `deny`)
config/
└── default.json           # Default base configuration template
scripts/
├── smoke-matrix.mjs       # Smoke testing matrix across agents
├── release.mjs            # Release workflow (GitHub release, npm publish, Homebrew formula)
└── generate-homebrew-formula.mjs # Homebrew tap formula generator
Formula/
└── acp-to-api.rb          # Generated Homebrew formula
```

## Key Mechanisms

### 1. Agent Discovery & Initialization (`init.ts`)
- Run `acp-to-api init` (or `bun run start init`) to scan system `PATH` for supported ACP agent binaries (`opencode`, `claude`, `codex`, `cursor`, `devin`, `goose`, `copilot`, `kiro`, `grok`, `qoder`, `junie`, `aider`, `cline`, `amp`, `droid`).
- Generates or updates `$XDG_CONFIG_HOME/acp-to-api/config.toml` (defaults to `~/.config/acp-to-api/config.toml`).

### 2. Workspace CWD Resolution (`src/util/messages.ts`)
Workspace directories (`cwd`) are resolved in the following priority order:
1. Request metadata explicit `cwd` or `workspace_path` (`meta.cwd` / `meta.workspace_path`)
2. Agent-specific `cwd` configuration (`agents.<name>.cwd`)
3. Global `config.defaultCwd` (defaults to `~/.config/acp-to-api/cwd-acp-to-api`)
4. Inferred common existing parent directory from paths referenced in prompt messages
5. Fallback directory (`process.cwd()`)

Tilde paths (`~`, `~/...`) are expanded to `$HOME`. If a specified path points to a file, `resolveCwd` resolves to its parent directory (`dirname`).

### 3. Model ID Routing & Catalog (`src/acp/catalog.ts`)
Model identifiers follow these patterns:
- `acp-<agent>` — Agent's default model (e.g., `acp-opencode`)
- `acp-<agent>/<model>` — Specific model via agent (e.g., `acp-opencode/claude-3-5-sonnet`)
- `acp-oz/<model>@effort` — Oz reasoning effort levels (e.g., `acp-oz/claude-3-5-sonnet@high`)

Model discovery runs asynchronously in the background and is cached to disk (`~/.cache/acp-to-api/models-catalog.json`).

### 4. Session Pooling (`src/acp/pool.ts`)
- Manages active ACP process sessions over stdio.
- Reuses sessions based on `session_id` (or `user` ID) for multi-turn conversations.
- Enforces `maxGlobal` and `maxPerAgent` limits, automatically closing idle sessions after `idleTtlMs`.

## Development Commands

```bash
bun test             # Run unit tests (Bun runner)
bun run typecheck    # Run TypeScript typechecker (`tsc --noEmit`)
bun run dev          # Start server in watch mode
bun run start        # Start production server
bun run smoke        # Execute smoke test matrix against active server
bun run release:dry  # Test release process (dry run)
```
