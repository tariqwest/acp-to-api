# ACP-to-API: Multi-Agent OpenAI Gateway

## Problem
Expose local ACP agents (and their models) to arbitrary OpenAI-compatible clients over REST.

## Stack decision
Rebuild in TypeScript (Bun + Hono + Zod + `@agentclientprotocol/sdk`). Custom Hono OpenAI routes; ACP runtime in-house.

## Target architecture
```text
OpenAI clients
   │  /v1/models, /v1/chat/completions
   ▼
Hono gateway (auth, validation, SSE)
   │
   ├─ ModelCatalog  → agentId + modelId (+ mode/effort)
   ├─ SessionPool   → warm ACP children, session affinity, TTL/LRU
   └─ AgentRuntime  → initialize/new, set model/config, prompt, cancel
            │ stdio NDJSON ACP
            ▼
   devin | opencode | agy-acp | oz-acp | fm-acp
```

## Model ID scheme
- `acp-<agent>` → agent default model
- `acp-<agent>/<model>` → explicit model
- optional `@effort` suffix where needed (oz)

## Implementation phases
0. Baseline & acceptance
1. TS gateway skeleton
2. Adapters for requested agents
3. Model catalog quality
4. OpenAI compatibility hardening
5. Stretch (`/v1/responses`, tool progress, metrics)

## Non-goals (v1)
- Full multi-agent orchestrator/pipeline engine
- MITM IDE traffic
- Implementing ACP agents themselves
- Perfect token accounting when agents don’t report usage

## Notes on existing tools
- acpbox (Python): right OpenAI shape, weak multi-agent
- xiwan/acp-bridge: pool, not OpenAI
- aiyo-acp: closest TS product match but early — evaluate, don’t depend
- Hebo gateway: good schema/SSE patterns; AI-SDK provider oriented
