import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppConfig, TokenUsage } from "./types.ts";
import { Registry } from "./adapters/registry.ts";
import { SessionPool } from "./acp/pool.ts";
import { ModelCatalog } from "./acp/catalog.ts";
import {
  ChatCompletionsRequestSchema,
  completionId,
  openaiError,
  toSseChunk,
} from "./openai/schema.ts";
import { contentToText, messagesToPrompt, resolveCwd, type ChatMessage } from "./util/messages.ts";

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
    const promptText = reused
      ? latestUserPrompt(messages) || messagesToPrompt(messages, req.tools) || "User: Hello"
      : messagesToPrompt(messages, req.tools) || "User: Hello";

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
          let usage: TokenUsage | undefined;
          try {
            for await (const ev of handle.prompt(promptText, abort.signal)) {
              if (ev.kind === "text") {
                send({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: modelName,
                  choices: [
                    {
                      index: 0,
                      delta: { content: ev.text },
                      finish_reason: null,
                    },
                  ],
                });
              } else if (ev.kind === "tool") {
                send({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: modelName,
                  choices: [{ index: 0, delta: {}, finish_reason: null }],
                  acp: { tool: ev.tool },
                });
              } else if (ev.kind === "done") {
                usage = ev.usage;
                send({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: modelName,
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason: mapStopReason(ev.stopReason),
                    },
                  ],
                  usage: usage ?? zeroUsage(),
                });
              }
            }
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
            ctx.pool.release(handle, false);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            send({
              error: { message: msg, type: "agent_error" },
            });
            controller.close();
            ctx.pool.release(handle, true);
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
      let finish = "stop";
      let usage: TokenUsage = zeroUsage();
      for await (const ev of handle.prompt(promptText, abort.signal)) {
        if (ev.kind === "text") parts.push(ev.text);
        else if (ev.kind === "tool") tools.push(ev.tool);
        else if (ev.kind === "done") {
          finish = mapStopReason(ev.stopReason) ?? "stop";
          if (ev.usage) usage = ev.usage;
        }
      }
      const content = parts.join("") || "No assistant text captured from agent.";
      ctx.pool.release(handle, false);
      return c.json({
        id,
        object: "chat.completion",
        created,
        model: modelName,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: finish,
          },
        ],
        usage,
        ...(tools.length ? { acp: { tools } } : {}),
      });
    } catch (err) {
      ctx.pool.release(handle, true);
      return openaiError(502, err instanceof Error ? err.message : String(err), "agent_error");
    }
  });

  app.notFound((c) => openaiError(404, `Unknown route: ${c.req.path}`));

  return app;
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

function mapStopReason(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("cancel")) return "stop";
  if (r.includes("length") || r.includes("max")) return "length";
  if (r.includes("tool")) return "tool_calls";
  return "stop";
}

function zeroUsage(): TokenUsage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}
