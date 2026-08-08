# acp-to-api

OpenAI-compatible REST gateway for local [Agent Client Protocol](https://agentclientprotocol.com) agents.

```text
OpenAI clients → Hono /v1/* → ACP stdio agents (opencode, devin)
```

## Requirements

- [Bun](https://bun.sh) 1.1+
- One or more ACP agents on `PATH` (or configured absolute paths)

| Agent id | Default launch |
|---|---|
| `opencode` | `opencode acp` |
| `claude` | `claude acp` |
| `codex` | `codex acp` |
| `cursor` | `cursor-agent acp` |
| `devin` | `devin acp` |
| `goose` | `goose acp` |
| `copilot` | `copilot acp` |
| `kiro` | `kiro-cli acp` |
| `grok` | `grok acp` |
| `qoder` | `qodercli acp` |
| `junie` | `junie acp` |
| `aider` | `aider acp` |
| `cline` | `cline acp` |
| `amp` | `amp acp` |
| `droid` | `droid acp` |

## Quick start

```bash
cd ~/Developer/acp-to-api
bun install

# Automatically detect local ACP clients and set up config.toml
bun run start init

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

### Capability matrix

Honest feature support is exposed at:

- `GET /v1/capabilities` — full matrix (`enforced` | `best_effort` | `ignored` | `unsupported`)
- `GET /v1/models` / `GET /v1/models/:id` — each model includes `metadata.capabilities` and `metadata.sampling`

### Tools protocol (best-effort)

- Request `tools` + `tool_choice` are validated and injected into the ACP prompt with JSON schemas
- Assistant replies may include OpenAI-shaped `message.tool_calls` when:
  - the model emits a `{"tool_calls":[...]}` JSON block, or
  - ACP tool events are mapped (when client `tools` were not supplied)
- Full client-side tool round-trips are **not** a complete OpenAI tools runtime (agent still owns workspace tools)

### Responses API subset

- `POST /v1/responses` — maps `input` / `instructions` / `messages` onto the same ACP chat path
- Returns OpenAI-ish `response` objects (`output` message + optional `function_call` items)
- Streaming emits `response.completed` then `[DONE]` (not full Responses event taxonomy)

### Finish reasons + choice metadata

- `choices[0].index` is always `0` (`n` must be `1`; `n>1` returns 400)
- `finish_reason`: `stop` | `length` | `tool_calls` | `content_filter` | `function_call` (mapped from ACP `stopReason`)
- `logprobs` is always `null` (not available from ACP)
- `message.refusal` set when `finish_reason` is `content_filter`
- `usage` always present on non-stream responses; on stream, included on the final chunk unless `stream_options.include_usage: false`
- Token counts are best-effort (ACP `usage_update` is often context `used`; completion may be estimated from text length)

### Structured outputs (`response_format`)

Best-effort OpenAI-compatible structured outputs over ACP agents (prompt + extract + validate — **not** constrained decoding):

- `response_format: { "type": "json_object" }` — require a JSON object; canonical JSON string in `message.content`
- `response_format: { "type": "json_schema", "json_schema": { "name", "schema", "strict?" } }` — Ajv validation against the schema
- One automatic repair turn if the first agent reply fails validation
- Default `strict: true` for `json_schema` (and always for `json_object`): invalid output → HTTP 400 (`structured_output_error`) after repair; set `strict: false` to soft-fail and return text
- Streaming buffers agent text when `response_format` is set, then emits one content delta with the canonical JSON

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

## Configuration

### Auto-initialize config.toml

Run `acp-to-api init` (or `bun run start init`) to scan your system for available built-in ACP agents (`opencode`, `claude`, `codex`, `cursor`, `devin`, `goose`, `copilot`, `kiro`, `grok`, `qoder`, `junie`, `aider`, `cline`, `amp`, `droid`) and interactively copy their configurations to your `config.toml`:

```bash
acp-to-api init
# or pass --yes to auto-enable all detected clients without prompting:
acp-to-api init --yes
```

### TOML Config ($XDG_CONFIG_HOME)

The gateway client registry and server settings can be configured via a TOML file placed in `$XDG_CONFIG_HOME/acp-to-api/config.toml` (defaults to `~/.config/acp-to-api/config.toml`).

```toml
host = "*********"
port = 8787
default_cwd = "~/.config/acp-to-api/cwd-acp-to-api"
permission_mode = "auto_allow"
discover_models = true
discover_timeout_ms = 12000
catalog_cache = "~/.cache/acp-to-api/models-catalog.json"
catalog_cache_ttl_ms = 86400000
debug_updates = false

[pool]
max_global = 8
max_per_agent = 2
idle_ttl_ms = 300000

[agents.opencode]
enabled = true
command = "opencode"
args = ["acp"]
aliases = ["oc"]

[agents.myagent]
enabled = true
command = "my-agent-cli"
args = ["--acp"]
aliases = ["ma"]
default_model = "claude-3-5-sonnet"
cwd = "~/projects/myagent"
```

### Config env

| Env | Purpose |
|---|---|
| `ACP_TO_API_CONFIG` | custom config file path (overrides XDG path) |
| `ACP_TO_API_HOST` | bind host (default `*********`) |
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
bun test                # run unit tests
bun run start           # start gateway server
bun run dev             # start server in watch mode
bun run typecheck       # run TypeScript type check
bun run smoke           # run smoke test matrix
bun run formula         # print Homebrew formula
bun run formula:write   # write Formula/acp-to-api.rb
bun run release:dry     # dry-run GitHub + npm + Homebrew release
bun run release -- 0.1.1 # real release (all channels)
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
