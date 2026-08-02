# acp-to-api

OpenAI-compatible REST gateway for local [Agent Client Protocol](https://agentclientprotocol.com) agents.

```text
OpenAI clients → Hono /v1/* → ACP stdio agents (opencode, devin, oz-acp, agy-acp, fm-acp)
```

## Requirements

- [Bun](https://bun.sh) 1.1+
- One or more ACP agents on `PATH` (or configured absolute paths)

| Agent id | Default launch |
|---|---|
| `opencode` | `opencode acp` |
| `devin` | `devin acp` |
| `oz` | `node …/oz-acp/bin/oz-acp.mjs` |
| `agy` | `agy-acp` |
| `fm` | `fm-acp` |

## Quick start

```bash
cd ~/Developer/acp-to-api
bun install
bun run start
```

Server defaults to `http://127.0.0.1:8787`.

Startup is fast: agent defaults load immediately, and a disk-backed model catalog cache is used when present. Full model discovery continues in the background.

```bash
curl -s http://127.0.0.1:8787/v1/models | jq '.data | length'

curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "acp-opencode",
    "messages": [{"role":"user","content":"Reply with the word pong only."}]
  }' | jq
```

### Model ids

- `acp-<agent>` — agent default model
- `acp-<agent>/<model>` — explicit upstream model (from discovery / config options)
- `acp-oz/<model>@high` — oz effort (via session config)

### Multi-turn affinity

Pass a stable `metadata.session_id` (or `user`) so the gateway reuses the same ACP session and only forwards the latest user turn.

### Usage + tool extensions

- ACP `usage_update` → OpenAI `usage` (`prompt_tokens`/`total_tokens` = context `used`)
- ACP `tool_call` / `tool_call_update` → non-standard `acp.tools` (non-stream) or chunk field `acp.tool` (stream)

### Smoke matrix

```bash
bun run start   # separate terminal
bun run smoke
SMOKE_AGENTS=opencode,devin,agy bun run smoke
```

Environment-dependent results: opencode/devin/agy typically OK; oz needs Warp AI plan or BYO inference; fm needs healthy Terminal-hosted `fm serve`.

## Config env

| Env | Purpose |
|---|---|
| `ACP_TO_API_HOST` | bind host (default `127.0.0.1`) |
| `ACP_TO_API_PORT` | port (default `8787`) |
| `ACP_TO_API_TOKEN` | optional Bearer token |
| `ACP_TO_API_CWD` | default workspace |
| `ACP_TO_API_PERMISSION_MODE` | `auto_allow` \| `deny` |
| `ACP_TO_API_DISCOVER_MODELS` | `1` (default) background discover; `0` skip |
| `ACP_TO_API_DISCOVER_TIMEOUT_MS` | per-agent discovery timeout (default `12000`) |
| `ACP_TO_API_CATALOG_CACHE` | catalog cache path (default `~/.cache/acp-to-api/models-catalog.json`) |
| `ACP_TO_API_CATALOG_CACHE_TTL_MS` | cache staleness (default 24h) |
| `ACP_TO_API_DEBUG_UPDATES` | `1` log raw ACP session updates |

## Install

### npm / bun

```bash
npm install -g acp-to-api
# or
bun add -g acp-to-api
acp-to-api
```

### Homebrew

```bash
brew tap tariqwest/tap
brew install acp-to-api
acp-to-api
```

### From source

```bash
git clone https://github.com/tariqwest/acp-to-api.git
cd acp-to-api
bun install
bun run start
```

## Scripts

```bash
bun run start
bun run dev
bun run typecheck
bun run smoke
bun run formula                 # print Homebrew formula
bun run formula:write           # write Formula/acp-to-api.rb
bun run release:dry             # dry-run GitHub + npm + Homebrew
bun run release -- 0.1.1        # real release (all channels)
```

## Release

Single script covers GitHub, npm, and Homebrew (all on by default):

```bash
# preview
bun run release -- 0.1.0 --dry-run

# ship everything
bun run release -- 0.1.0 --yes

# opt out of channels
bun run release -- 0.1.0 --no-npm
bun run release -- 0.1.0 --no-homebrew
bun run release -- 0.1.0 --github-only
bun run release -- patch --npm-only
```

Requirements for a real release: clean git tree on `main`, `gh` auth, and `npm login` when publishing.

Plan: [`.agents/plans/multi-agent-openai-gateway.md`](./.agents/plans/multi-agent-openai-gateway.md)

## License

MIT
