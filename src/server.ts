import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppConfig, StreamEvent, TokenUsage } from "./types.ts";
import { Registry } from "./adapters/registry.ts";
import { SessionPool } from "./acp/pool.ts";
import { ModelCatalog } from "./acp/catalog.ts";
import {
  ChatCompletionsRequestSchema,
  ResponsesRequestSchema,
  completionId,
  openaiError,
  responseId,
  toSseChunk,
} from "./openai/schema.ts";
import {
  buildNonStreamChoice,
  buildStreamChoice,
  estimateUsageFromText,
  mapStopReason,
  shouldIncludeStreamUsage,
  type FinishReason,
} from "./openai/completion-meta.ts";
import { buildCapabilityCard } from "./openai/capabilities.ts";
import {
  acpToolsToOpenAIToolCalls,
  extractEmbeddedToolCalls,
  mergeToolCalls,
  type OpenAIToolCall,
} from "./openai/tools.ts";
import { buildResponsesObject, responsesInputToMessages } from "./openai/responses.ts";
import { contentToText, messagesToPrompt, resolveCwd, type ChatMessage } from "./util/messages.ts";
import {
  appendStructuredOutputInstructions,
  repairStructuredOutputPrompt,
  responseFormatToSpec,
  structureAssistantText,
  type StructuredOutputSpec,
} from "./util/structured-output.ts";

export interface AppContext {
  config: AppConfig;
  registry: Registry;
  pool: SessionPool;
  catalog: ModelCatalog;
}

export function createApp(ctx: AppContext) {
  const app = new Hono();

  app.use("*", cors());

  app.use("/v1/*", async (c, next) => {
    const token = ctx.config.authToken;
    if (!token) return next();
    const header = c.req.header("authorization") ?? "";
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (!m || m[1] !== token) {
      return openaiError(401, "Invalid API key", "invalid_api_key");
    }
    return next();
  });

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      agents: ctx.registry.listAgentIds(),
      models: ctx.catalog.list().length,
    }),
  );

  app.get("/v1/models", (c) =>
    c.json({
      object: "list",
      data: ctx.catalog.list(),
    }),
  );

  app.get("/v1/models/:id", (c) => {
    const id = c.req.param("id");
    const model = ctx.catalog.list().find((m) => m.id === id);
    if (!model) return openaiError(404, `Model not found: ${id}`, "model_not_found");
    return c.json(model);
  });

  /** Honest capability matrix (non-standard OpenAI extension). */
  app.get("/v1/capabilities", (c) => c.json(buildCapabilityCard()));

  app.post("/v1/chat/completions", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return openaiError(400, "Invalid JSON body");
    }

    const parsed = ChatCompletionsRequestSchema.safeParse(body);
    if (!parsed.success) {
      return openaiError(400, parsed.error.message);
    }
    const req = parsed.data;

    if (req.n != null && req.n !== 1) {
      return openaiError(
        400,
        "Only n=1 is supported (ACP agent sessions produce a single choice)",
        "invalid_request_error",
      );
    }

    let resolved;
    try {
      resolved = ctx.registry.resolveModel(req.model);
    } catch (err) {
      return openaiError(404, err instanceof Error ? err.message : String(err), "model_not_found");
    }

    const spec = ctx.registry.getSpec(resolved.agentId);
    if (!spec) return openaiError(404, `Agent not configured: ${resolved.agentId}`);

    const meta = (req.metadata ?? {}) as Record<string, unknown>;
    const explicitCwd =
      (typeof meta.cwd === "string" && meta.cwd) ||
      (typeof meta.workspace_path === "string" && meta.workspace_path) ||
      spec.cwd ||
      ctx.config.defaultCwd;

    const messages = req.messages as ChatMessage[];
    const cwd = resolveCwd({
      explicit: explicitCwd,
      messages,
      fallback: process.cwd(),
    });

    const clientSessionId =
      (typeof meta.session_id === "string" && meta.session_id) ||
      (typeof meta.sessionId === "string" && meta.sessionId) ||
      undefined;
    const clientKey = clientSessionId
      ? `sid:${clientSessionId}`
      : req.user
        ? `user:${req.user}:${resolved.agentId}:${cwd}`
        : undefined;

    const permissionMode =
      meta.permission_mode === "deny" || meta.permissionMode === "deny"
        ? "deny"
        : ctx.config.permissionMode;

    let handle;
    let reused = false;
    try {
      const acquired = await ctx.pool.acquire({
        spec,
        cwd,
        permissionMode,
        model: resolved,
        clientKey,
      });
      handle = acquired.handle;
      reused = acquired.reused;
    } catch (err) {
      return openaiError(
        502,
        `Failed to start agent: ${err instanceof Error ? err.message : String(err)}`,
        "agent_error",
      );
    }

    // Multi-turn: on reused ACP session, only send the latest user turn.
    // Fresh sessions get the full flattened conversation.
    const promptOpts = { tools: req.tools, toolChoice: req.tool_choice };
    const basePrompt = reused
      ? latestUserPrompt(messages) || messagesToPrompt(messages, promptOpts) || "User: Hello"
      : messagesToPrompt(messages, promptOpts) || "User: Hello";

    const structuredSpec = responseFormatToSpec(req.response_format);
    const promptText = appendStructuredOutputInstructions(basePrompt, structuredSpec);

    const id = completionId();
    const created = Math.floor(Date.now() / 1000);
    const modelName = resolved.id;
    const abort = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => abort.abort(), { once: true });

    if (req.stream) {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder();
          const send = (obj: unknown) => controller.enqueue(enc.encode(toSseChunk(obj)));
          const sendDone = () => controller.enqueue(enc.encode("data: [DONE]\n\n"));
          let usage: TokenUsage | undefined;
          const parts: string[] = [];
          let finish: FinishReason = "stop";
          let tools: unknown[] = [];
          try {
            for await (const ev of handle.prompt(promptText, abort.signal)) {
              if (ev.kind === "text") {
                parts.push(ev.text);
                // When structured output is requested, buffer raw agent text and emit
                // a single canonical JSON delta after validation (OpenAI-ish contract).
                if (!structuredSpec) {
                  send({
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model: modelName,
                    choices: [buildStreamChoice({ delta: { content: ev.text } })],
                  });
                }
              } else if (ev.kind === "tool") {
                tools.push(ev.tool);
                send({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: modelName,
                  choices: [buildStreamChoice({ delta: {} })],
                  acp: { tool: ev.tool },
                });
              } else if (ev.kind === "done") {
                usage = ev.usage;
                finish = mapStopReason(ev.stopReason);
              }
            }

            let content = parts.join("") || "No assistant text captured from agent.";
            if (structuredSpec) {
              const structured = await enforceStructuredOutput({
                handle,
                abort,
                spec: structuredSpec,
                text: content,
              });
              if (!structured.ok) {
                send({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: modelName,
                  choices: [buildStreamChoice({ delta: {}, finishReason: "stop" })],
                  error: {
                    message: structured.error,
                    type: "invalid_request_error",
                    code: "structured_output_error",
                  },
                });
                sendDone();
                controller.close();
                ctx.pool.release(handle!, true);
                return;
              }
              content = structured.text;
              send({
                id,
                object: "chat.completion.chunk",
                created,
                model: modelName,
                choices: [
                  buildStreamChoice({ delta: { role: "assistant", content } }),
                ],
              });
            }

            const embedded = extractEmbeddedToolCalls(content);
            const fromAcp = acpToolsToOpenAIToolCalls(tools as Parameters<typeof acpToolsToOpenAIToolCalls>[0]);
            const tool_calls =
              req.tools?.length
                ? embedded.tool_calls.length
                  ? embedded.tool_calls
                  : []
                : fromAcp;
            if (embedded.tool_calls.length) content = embedded.text;
            if (tool_calls.length && finish === "stop") finish = "tool_calls";

            // Emit tool_calls as a delta chunk (OpenAI streaming shape, simplified).
            if (tool_calls.length) {
              send({
                id,
                object: "chat.completion.chunk",
                created,
                model: modelName,
                choices: [
                  buildStreamChoice({
                    delta: {
                      role: "assistant",
                      content: content || null,
                      tool_calls: tool_calls.map((tc, i) => ({
                        index: i,
                        id: tc.id,
                        type: tc.type,
                        function: tc.function,
                      })),
                    },
                  }),
                ],
              });
            }

            const finalUsage = estimateUsageFromText(usage, content);
            send({
              id,
              object: "chat.completion.chunk",
              created,
              model: modelName,
              choices: [buildStreamChoice({ delta: {}, finishReason: finish })],
              ...(tools.length ? { acp: { tools } } : {}),
              ...(shouldIncludeStreamUsage(req.stream_options) ? { usage: finalUsage } : {}),
            });
            // OpenAI sometimes sends a separate usage-only chunk when include_usage is true.
            // We keep usage on the finish chunk for broader client compatibility.
            sendDone();
            controller.close();
            ctx.pool.release(handle!, false);
          } catch (err) {
            try {
              send({
                id,
                object: "chat.completion.chunk",
                created,
                model: modelName,
                choices: [buildStreamChoice({ delta: {}, finishReason: "stop" })],
                error: {
                  message: err instanceof Error ? err.message : String(err),
                  type: "agent_error",
                },
              });
              sendDone();
            } catch {
              /* client gone */
            }
            controller.close();
            ctx.pool.release(handle!, true);
          }
        },
        cancel() {
          abort.abort();
          ctx.pool.release(handle!, true);
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    try {
      const parts: string[] = [];
      const tools: unknown[] = [];
      let finish: FinishReason = "stop";
      let usage: TokenUsage | undefined;
      for await (const ev of handle.prompt(promptText, abort.signal)) {
        if (ev.kind === "text") parts.push(ev.text);
        else if (ev.kind === "tool") tools.push(ev.tool);
        else if (ev.kind === "done") {
          finish = mapStopReason(ev.stopReason);
          if (ev.usage) usage = ev.usage;
        }
      }
      let content = parts.join("") || "No assistant text captured from agent.";
      if (structuredSpec) {
        const structured = await enforceStructuredOutput({
          handle,
          abort,
          spec: structuredSpec,
          text: content,
        });
        if (!structured.ok) {
          ctx.pool.release(handle, true);
          return openaiError(400, structured.error, "structured_output_error");
        }
        content = structured.text;
      }
      const embedded = extractEmbeddedToolCalls(content);
      const fromAcp = acpToolsToOpenAIToolCalls(tools as Parameters<typeof acpToolsToOpenAIToolCalls>[0]);
      // Prefer client-protocol tool_calls from text when tools were requested; else ACP tools.
      const openaiToolCalls = mergeToolCalls(
        req.tools?.length ? embedded.tool_calls : [],
        req.tools?.length ? [] : fromAcp,
      );
      // If client tools requested, also merge ACP only when no embedded calls
      const tool_calls =
        openaiToolCalls.length > 0
          ? openaiToolCalls
          : req.tools?.length
            ? embedded.tool_calls
            : fromAcp;
      if (embedded.tool_calls.length) content = embedded.text;
      if (tool_calls.length && finish === "stop") finish = "tool_calls";

      const finalUsage = estimateUsageFromText(usage, content);
      const refusal = finish === "content_filter" ? content : null;
      ctx.pool.release(handle, false);
      return c.json({
        id,
        object: "chat.completion",
        created,
        model: modelName,
        choices: [
          buildNonStreamChoice({
            content: finish === "content_filter" ? "" : content || (tool_calls.length ? null : content),
            finishReason: finish,
            refusal: finish === "content_filter" ? refusal : null,
            tool_calls: tool_calls.length ? tool_calls : undefined,
          }),
        ],
        usage: finalUsage,
        ...(tools.length ? { acp: { tools } } : {}),
      });
    } catch (err) {
      ctx.pool.release(handle, true);
      return openaiError(502, err instanceof Error ? err.message : String(err), "agent_error");
    }
  });


  /**
   * OpenAI Responses API subset — mapped onto the same ACP chat path.
   * Supports non-stream JSON responses; stream=true returns SSE response.completed events.
   */
  app.post("/v1/responses", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return openaiError(400, "Invalid JSON body");
    }
    const parsed = ResponsesRequestSchema.safeParse(body);
    if (!parsed.success) return openaiError(400, parsed.error.message);
    const req = parsed.data;

    let resolved;
    try {
      resolved = ctx.registry.resolveModel(req.model);
    } catch (err) {
      return openaiError(404, err instanceof Error ? err.message : String(err), "model_not_found");
    }
    const agentSpec = ctx.registry.getSpec(resolved.agentId);
    if (!agentSpec) return openaiError(404, `Agent not configured: ${resolved.agentId}`);

    const meta = (req.metadata ?? {}) as Record<string, unknown>;
    const explicitCwd =
      (typeof meta.cwd === "string" && meta.cwd) ||
      (typeof meta.workspace_path === "string" && meta.workspace_path) ||
      agentSpec.cwd ||
      ctx.config.defaultCwd;

    const messages = responsesInputToMessages({
      input: req.input,
      instructions: req.instructions,
      messages: req.messages as ChatMessage[] | undefined,
    });
    const cwd = resolveCwd({ explicit: explicitCwd, messages, fallback: process.cwd() });
    const clientSessionId =
      (typeof meta.session_id === "string" && meta.session_id) ||
      (typeof meta.sessionId === "string" && meta.sessionId) ||
      undefined;
    const clientKey = clientSessionId
      ? `sid:${clientSessionId}`
      : req.user
        ? `user:${req.user}:${resolved.agentId}:${cwd}`
        : undefined;
    const permissionMode =
      meta.permission_mode === "deny" || meta.permissionMode === "deny"
        ? "deny"
        : ctx.config.permissionMode;

    let handle;
    let reused = false;
    try {
      const acquired = await ctx.pool.acquire({
        spec: agentSpec,
        cwd,
        permissionMode,
        model: resolved,
        clientKey,
      });
      handle = acquired.handle;
      reused = acquired.reused;
    } catch (err) {
      return openaiError(
        502,
        `Failed to start agent: ${err instanceof Error ? err.message : String(err)}`,
        "agent_error",
      );
    }

    const promptOpts = { tools: req.tools, toolChoice: req.tool_choice };
    const basePrompt = reused
      ? latestUserPrompt(messages) || messagesToPrompt(messages, promptOpts) || "User: Hello"
      : messagesToPrompt(messages, promptOpts) || "User: Hello";
    const promptText = basePrompt;
    const id = responseId();
    const created = Math.floor(Date.now() / 1000);
    const modelName = resolved.id;
    const abort = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => abort.abort(), { once: true });

    const run = async () => {
      const parts: string[] = [];
      const tools: unknown[] = [];
      let finish: FinishReason = "stop";
      let usage: TokenUsage | undefined;
      for await (const ev of handle.prompt(promptText, abort.signal)) {
        if (ev.kind === "text") parts.push(ev.text);
        else if (ev.kind === "tool") tools.push(ev.tool);
        else if (ev.kind === "done") {
          finish = mapStopReason(ev.stopReason);
          if (ev.usage) usage = ev.usage;
        }
      }
      let content = parts.join("") || "";
      const embedded = extractEmbeddedToolCalls(content);
      const fromAcp = acpToolsToOpenAIToolCalls(tools as Parameters<typeof acpToolsToOpenAIToolCalls>[0]);
      const tool_calls = req.tools?.length
        ? embedded.tool_calls
        : mergeToolCalls(fromAcp, embedded.tool_calls);
      if (embedded.tool_calls.length) content = embedded.text;
      if (tool_calls.length && finish === "stop") finish = "tool_calls";
      const finalUsage = estimateUsageFromText(usage, content);
      return { content, finish, finalUsage, tool_calls, tools };
    };

    if (req.stream) {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder();
          const send = (obj: unknown) => controller.enqueue(enc.encode(toSseChunk(obj)));
          try {
            const result = await run();
            ctx.pool.release(handle!, false);
            const payload = buildResponsesObject({
              id,
              model: modelName,
              content: result.content,
              finishReason: result.finish,
              usage: result.finalUsage,
              tool_calls: result.tool_calls,
              created,
            });
            send({ type: "response.completed", response: payload });
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (err) {
            send({
              type: "error",
              error: {
                message: err instanceof Error ? err.message : String(err),
                type: "agent_error",
              },
            });
            controller.close();
            ctx.pool.release(handle!, true);
          }
        },
        cancel() {
          abort.abort();
          ctx.pool.release(handle!, true);
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    try {
      const result = await run();
      ctx.pool.release(handle, false);
      return c.json(
        buildResponsesObject({
          id,
          model: modelName,
          content: result.content,
          finishReason: result.finish,
          usage: result.finalUsage,
          tool_calls: result.tool_calls,
          created,
        }),
      );
    } catch (err) {
      ctx.pool.release(handle, true);
      return openaiError(502, err instanceof Error ? err.message : String(err), "agent_error");
    }
  });


  app.notFound((c) => openaiError(404, `Unknown route: ${c.req.path}`));

  return app;
}


type PromptHandle = {
  prompt: (text: string, signal?: AbortSignal) => AsyncIterable<StreamEvent>;
};

/**
 * Validate assistant text against response_format. On failure, one repair prompt is attempted.
 * strict json_schema (default) and json_object hard-fail after repair; non-strict schema soft-fails to raw text.
 */
async function enforceStructuredOutput(args: {
  handle: PromptHandle;
  abort: AbortController;
  spec: StructuredOutputSpec;
  text: string;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const { handle, abort, spec } = args;
  let text = args.text;
  let result = structureAssistantText(text, spec);
  if (result.ok) return { ok: true, text: result.text };

  // One-shot repair via another ACP prompt turn.
  try {
    const repairPrompt = repairStructuredOutputPrompt(spec, result.error, text);
    const parts: string[] = [];
    for await (const ev of handle.prompt(repairPrompt, abort.signal)) {
      if (ev.kind === "text") parts.push(ev.text);
    }
    text = parts.join("") || text;
    result = structureAssistantText(text, spec);
    if (result.ok) return { ok: true, text: result.text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (spec.strict) {
      return { ok: false, error: `Structured output repair failed: ${msg}` };
    }
    return { ok: true, text: args.text };
  }

  if (!spec.strict) {
    // Soft mode: return best-effort original (or repair) text without hard error.
    return { ok: true, text: result.text || args.text };
  }
  return { ok: false, error: result.error };
}

function latestUserPrompt(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    const role = String(msg.role ?? "user").toLowerCase();
    if (role !== "user") continue;
    const text = contentToText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

