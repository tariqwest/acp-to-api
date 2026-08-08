# OpenAI-compatible API gap analysis: acp-to-api

Date: 2026-08-08  
Scope: What common OpenAI-API-compatible server features are missing from the ACP-wrapper approach (`acp-to-api`).

## What exists today

Routes:

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions` (non-stream + SSE stream)

Request surface (`ChatCompletionsRequestSchema`):

- Honored in some form: `model`, `messages`, `stream`, `tools` (text hints only), `user`, `metadata`, optional `temperature` / `max_tokens` (accepted, not applied as model sampling controls)

Behavior:

- Flatten chat history into a single ACP prompt via `messagesToPrompt`
- Map multimodal content parts to text placeholders (`[image]`, `[image:url]`, etc.)
- Stream agent/assistant text chunks as OpenAI-style SSE `chat.completion.chunk`
- Session affinity via pool + `user` / `metadata.session_id`
- Optional Bearer auth; CORS open

ACP mapping:

- Agent sessions via ACP client/pool
- Model selection via catalog + agent config
- Permissions modes for agent tool use (agent-side), not OpenAI function-calling protocol

---

## Missing API surface (endpoints)

Typical OpenAI-compatible servers expose more than chat:

1. **Embeddings** — `POST /v1/embeddings`
2. **Images** — `POST /v1/images/generations`, edits, variations
3. **Audio** — `POST /v1/audio/transcriptions`, `translations`, `speech` (TTS)
4. **Moderations** — `POST /v1/moderations`
5. **Completions (legacy)** — `POST /v1/completions`
6. **Responses API** — `POST /v1/responses` (and related retrieve/cancel/list patterns)
7. **Files / vector stores / batches** — upload, batch jobs, file-backed retrieval
8. **Fine-tuning / models CRUD** — create/delete fine-tunes; delete custom models
9. **Assistants / threads / runs** (Assistants v2-style stateful API)
10. **Realtime / WebSocket** voice+tool sessions
11. **Rerank / other vendor extensions** (common in local OpenAI-compatible stacks)

Also thin around models:

- No `GET /v1/models/{id}`
- Catalog is agent/model discovery, not full OpenAI model metadata semantics

---

## Missing chat/completions protocol features

### Structured tool / function calling

Present: tools appended as prompt text hints.

Missing:

- OpenAI `tools` / `functions` protocol with `tool_calls` in assistant messages
- `tool` role messages with `tool_call_id` round-trips
- `tool_choice` (`none` | `auto` | `required` | forced function)
- Parallel tool calls
- Streaming tool-call deltas (`tool_calls[].function.arguments` chunks)
- `function_call` legacy field compatibility

Why it matters: most agent SDKs and routers expect protocol-level tools, not prose hints. ACP agents already use tools internally; that is not the same as exposing OpenAI tool-calling to the HTTP client.

### Multimodal inputs (vision / files as first-class content)

Present: non-text parts coerced to placeholders.

Missing:

- Real image input (`image_url` with URL or base64) passed through to a vision-capable model
- Audio / file inputs as content parts
- Any guarantee that the downstream agent can see binary/media payloads

### Structured outputs / response format

**Implemented (best-effort, 2026-08):** prompt instructions + JSON extraction + Ajv validation + one repair turn. Not true constrained decoding.

- `response_format: { type: "json_object" }` — enforced post-hoc
- `response_format: { type: "json_schema", json_schema: ... }` — Ajv validate; `strict` defaults true
- Still missing: model-level constrained decoding guarantees

### Sampling and generation controls

Accepted or ignored rather than enforced at a model-runtime layer:

- `temperature`, `top_p`, `top_k` (vendor)
- `max_tokens` / `max_completion_tokens`
- `stop` / `stop_sequences`
- `seed` + deterministic sampling
- `n` > 1 (multiple choices)
- `presence_penalty`, `frequency_penalty`, `logit_bias`
- `logprobs` / `top_logprobs`
- `service_tier`, prediction/prefill extensions, etc.

ACP agents may not expose these knobs; the wrapper currently cannot honestly implement them as OpenAI semantics.

### Streaming completeness

Present: text token/chunk SSE in chat.completion shape.

Missing / partial:

- `stream_options.include_usage` (usage on final chunk) as a hard contract
- Tool-call streaming events
- Refusal / content-filter style intermediate events
- True token-level deltas when agents only emit coarser message updates
- Cancellation semantics aligned with client disconnect vs agent cancel (if incomplete)
- OpenAI-compatible error events mid-stream in all failure modes

### Message roles and content fidelity

Flattening loses structure:

- Distinct `system` / `developer` / `user` / `assistant` / `tool` handling beyond text labels
- Name fields, multi-assistant turns, partial assistant prefill
- Exact multi-turn tool transcripts
- Attachments / citations / annotations as structured parts

### Finish reasons and choice metadata

**Implemented (best-effort, 2026-08):**

- `finish_reason`: `stop` | `length` | `tool_calls` | `content_filter` | `function_call` via `mapStopReason` from ACP stop reasons
- `choices[].index` always 0; `n>1` rejected with 400
- `logprobs: null`; `message.refusal` on content_filter
- `stream_options.include_usage` (default include usage on final stream chunk)
- Consistent `usage` shape; completion_tokens may be estimated when ACP only reports context used

Still missing: true multi-choice (`n`>1), tokenizer-accurate usage, cached/reasoning token breakdowns.

---

## Missing “platform” capabilities clients often assume

Even when only chat is needed, many OpenAI-compatible deployments also provide:

1. **Auth models** — org/project keys, multi-key, rate-limit headers (`x-ratelimit-*`)
2. **Usage accounting** — durable metering per key/model
3. **Idempotency keys**
4. **Request timeouts / cancel APIs** with stable response IDs for retrieval
5. **Strict CORS / network controls** (beyond open CORS)
6. **OpenAPI / discovery docs** matching OpenAI schemas
7. **Compatibility shims** for LiteLLM/OpenWebUI/Continue/Cline quirks (extra fields, alternate paths)

---

## Gaps inherent to the ACP-wrapper approach (not just TODOs)

These are structural, not merely unimplemented routes:

1. **Different abstraction**  
   OpenAI chat = model inference API. ACP = agent session protocol (tools, permissions, workspace cwd). Mapping agent transcripts into `chat.completion` is lossy.

2. **Non-model controls dominate**  
   Permission modes, cwd, agent binary, session pool affinity are first-class here; pure model servers ignore them. Conversely, sampling parameters may be meaningless or unenforceable.

3. **Tool ownership inversion**  
   In OpenAI function calling, the *client* runs tools. In ACP, the *agent* runs tools. Bridging both directions requires an explicit policy (expose agent tools as functions? proxy client tools into agent? both?) that does not exist yet.

4. **No native embeddings/audio/image models**  
   Unless an ACP agent implements those modalities and the wrapper adds endpoints, those APIs cannot be satisfied by “chat with an agent.”

5. **Latency and interactivity**  
   Agent loops (plan → tool → observe) do not match single-shot LLM completion SLAs; streaming text can look like a model while hiding long tool pauses unless you invent progress events (non-standard).

6. **Determinism and evaluation**  
   Seed/logprobs/json_schema constraints assume model decoding control. Agent stacks rarely provide that.

7. **Security boundary**  
   OpenAI-compatible servers usually sandbox to tokens in/out. ACP agents can execute tools on a real filesystem/shell — a different threat model that OpenAI clients do not expect from a “model base URL.”

---

## Practical compatibility tiers

### Tier A — works today for many chat UIs

- Point OpenAI SDK / proxy at base URL
- `models.list` + `chat.completions` text in/out
- Optional streaming text
- Optional Bearer token

### Tier B — common client breakages

- Apps that require tool_calls protocol
- Vision UIs sending images as content parts
- Strict JSON schema mode
- Multi-choice (`n`), logprobs, stop sequences
- Assistants API or Responses API only clients
- Embeddings-powered RAG frontends

### Tier C — never a pure drop-in without extra services

- Full multimodal platform (TTS/STT/images)
- Batch/fine-tune/vector store ecosystems
- Realtime WebRTC/WebSocket voice
- Bit-for-bit OpenAI edge behavior (filters, rate limits, usage)

---

## Highest-value gaps to close (if goal is “OpenAI-compatible enough”)

Ordered by impact for agent/gateway use:

1. **Honest capability matrix** — **done**: `GET /v1/capabilities` + model `metadata.capabilities`/`sampling`
2. **Native tool-calling bridge** — **best-effort done**: prompt schemas + `tool_choice`; `message.tool_calls` from embedded JSON or ACP tool map
3. **Preserve message structure** — **improved**: tool_call_id, tool_calls, function role, image placeholders
4. **Usage + finish_reason correctness** — **done** (best-effort mapping + stream_options)
5. **`response_format` json_object / json_schema** — **done** (prompt + Ajv + repair)
6. **Vision passthrough** only where agent/model supports it; otherwise hard error instead of silent `[image]` placeholder
7. **Optional `/v1/embeddings`** via external embedding backend (not ACP) if RAG clients are in scope
8. **Responses API subset** — **done**: `POST /v1/responses` mapped onto ACP chat

---

## Summary

`acp-to-api` is a **thin OpenAI Chat Completions façade over ACP agent sessions**, not a general OpenAI-compatible model server. The largest functional holes versus typical OpenAI-API servers are: non-chat endpoints (embeddings/images/audio/etc.), protocol-level tool calling, multimodal fidelity, structured outputs, sampling controls, and platform APIs (Assistants/Responses/Realtime/files). Several of those gaps are **fundamental to wrapping agents rather than models**; closing them requires explicit bridging design or sidecar services, not only more route handlers.
