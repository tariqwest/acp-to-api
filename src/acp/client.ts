import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentSpec, PermissionMode, ResolvedModel, StreamEvent, TokenUsage } from "../types.ts";
import {
  extractModelsFromConfigOptions,
  pickPermissionOptionId,
  sessionUpdateText,
  sessionUpdateTool,
  sessionUpdateUsage,
} from "../util/permissions.ts";

export interface DiscoveredModel {
  id: string;
  name?: string;
}

export interface AcpSessionHandle {
  agentId: string;
  sessionId: string;
  cwd: string;
  /** Client-provided affinity key (metadata.session_id / user), not ACP id */
  clientKey?: string;
  process: ChildProcessWithoutNullStreams;
  connection: acp.ClientSideConnection;
  discoveredModels: DiscoveredModel[];
  close: () => void;
  prompt: (text: string, signal?: AbortSignal) => AsyncGenerator<StreamEvent, void, unknown>;
  applyModel: (model: ResolvedModel) => Promise<void>;
  lastUsedAt: number;
}

export async function openAcpSession(options: {
  spec: AgentSpec;
  cwd: string;
  permissionMode: PermissionMode;
  mcpServers?: unknown[];
  clientKey?: string;
  debugUpdates?: boolean;
}): Promise<AcpSessionHandle> {
  const { spec, cwd, permissionMode, clientKey } = options;
  const resolvedArgs = spec.args.map((arg) => arg.replaceAll("{cwd}", cwd));
  const child = spawn(spec.command, resolvedArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...spec.env },
    cwd,
  });

  child.stderr.on("data", (buf: Buffer) => {
    const line = buf.toString("utf8").trim();
    if (line) console.error(`[acp:${spec.agentId}] ${line}`);
  });

  const input = Writable.toWeb(child.stdin);
  const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);

  const textBuf: string[] = [];
  const toolBuf: Array<NonNullable<ReturnType<typeof sessionUpdateTool>>> = [];
  let textWaiters: Array<() => void> = [];
  let closed = false;
  let promptActive = false;
  let lastUsage: TokenUsage | undefined;

  const wake = () => {
    const w = textWaiters.slice();
    textWaiters = [];
    for (const fn of w) fn();
  };

  const pushText = (t: string) => {
    if (!t) return;
    textBuf.push(t);
    wake();
  };

  const drainText = (): string => {
    if (!textBuf.length) return "";
    const out = textBuf.join("");
    textBuf.length = 0;
    return out;
  };

  const waitForTextOr = async (pred: () => boolean, timeoutMs = 50): Promise<string> => {
    const immediate = drainText();
    if (immediate || pred() || closed) return immediate;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        textWaiters = textWaiters.filter((fn) => fn !== onWake);
        resolve();
      };
      const onWake = () => finish();
      const timer = setTimeout(finish, timeoutMs);
      textWaiters.push(onWake);
    });
    return drainText();
  };

  const clientImpl: acp.Client = {
    async requestPermission(params) {
      if (permissionMode === "deny") {
        return { outcome: { outcome: "cancelled" } };
      }
      const optionsList = (params as { options?: Array<Record<string, unknown>> }).options ?? [];
      const optionId = pickPermissionOptionId(optionsList);
      if (optionId) {
        return { outcome: { outcome: "selected", optionId } };
      }
      const first = optionsList.find((o) => o && (o.optionId || o.option_id));
      if (first) {
        return {
          outcome: {
            outcome: "selected",
            optionId: String(first.optionId ?? first.option_id),
          },
        };
      }
      return { outcome: { outcome: "cancelled" } };
    },
    async sessionUpdate(params) {
      const update = (params as { update?: unknown }).update ?? params;
      const debug = options.debugUpdates ?? (process.env.ACP_TO_API_DEBUG_UPDATES === "1");
      if (debug) {
        try {
          console.error(`[acp:${spec.agentId}:update] ${JSON.stringify(update).slice(0, 500)}`);
        } catch {
          // ignore
        }
      }
      const usage = sessionUpdateUsage(update);
      if (usage) lastUsage = usage;
      const tool = sessionUpdateTool(update);
      if (tool) {
        toolBuf.push(tool);
        wake();
      }
      const text = sessionUpdateText(update);
      if (text) pushText(text);
    },
  };

  const connection = new acp.ClientSideConnection(() => clientImpl, stream);

  const close = () => {
    if (closed) return;
    closed = true;
    wake();
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  };

  child.on("exit", () => {
    closed = true;
    wake();
  });

  try {
    await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
      clientInfo: { name: "acp-to-api", version: "0.1.0" },
    } as acp.InitializeRequest);

    const session = await connection.newSession({
      cwd,
      mcpServers: (options.mcpServers as never[]) ?? [],
    });

    const sessionId = session.sessionId;
    const discoveredModels = extractModelsFromConfigOptions(
      (session as { configOptions?: unknown }).configOptions,
    );

    const runOnePrompt = async function* (
      text: string,
      signal?: AbortSignal,
    ): AsyncGenerator<StreamEvent, void, unknown> {
      if (promptActive) throw new Error("prompt already active on this session");
      promptActive = true;
      textBuf.length = 0;
      toolBuf.length = 0;
      lastUsage = undefined;
      let finished = false;
      let stopReason = "end_turn";
      let promptError: unknown;

      const onAbort = () => {
        void connection.cancel({ sessionId }).catch(() => undefined);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const promptPromise = connection
        .prompt({
          sessionId,
          prompt: [{ type: "text", text }],
        })
        .then((res) => {
          finished = true;
          stopReason = String((res as { stopReason?: string })?.stopReason ?? "end_turn");
          wake();
        })
        .catch((err) => {
          finished = true;
          stopReason = "error";
          promptError = err;
          wake();
        });

      try {
        while (!finished || textBuf.length) {
          if (signal?.aborted) {
            yield { kind: "done", stopReason: "cancelled", usage: lastUsage };
            return;
          }
          const chunk = await waitForTextOr(() => finished || closed || toolBuf.length > 0, 100);
          while (toolBuf.length) {
            const t = toolBuf.shift()!;
            yield { kind: "tool", tool: t };
          }
          if (chunk) yield { kind: "text", text: chunk };
          if (finished && !textBuf.length && !toolBuf.length) break;
        }
        await promptPromise;
        if (promptError) throw promptError;
        while (toolBuf.length) {
          const t = toolBuf.shift()!;
          yield { kind: "tool", tool: t };
        }
        const tail = drainText();
        if (tail) yield { kind: "text", text: tail };
        yield {
          kind: "done",
          stopReason: signal?.aborted ? "cancelled" : stopReason,
          usage: lastUsage,
        };
      } finally {
        signal?.removeEventListener("abort", onAbort);
        promptActive = false;
      }
    };

    for (const cmd of spec.bootstrapCommands) {
      const c = cmd.trim();
      if (!c) continue;
      try {
        for await (const _ev of runOnePrompt(c)) {
          // discard bootstrap output
        }
      } catch (err) {
        console.error(`[acp:${spec.agentId}] bootstrap failed: ${String(err)}`);
      }
    }

    return {
      agentId: spec.agentId,
      sessionId,
      cwd,
      clientKey,
      process: child,
      connection,
      discoveredModels,
      close,
      lastUsedAt: Date.now(),
      async *prompt(text, signal) {
        yield* runOnePrompt(text, signal);
      },
      async applyModel(model) {
        await applyModelSelection(connection, sessionId, model);
      },
    };
  } catch (err) {
    close();
    throw err;
  }
}

async function applyModelSelection(
  connection: acp.ClientSideConnection,
  sessionId: string,
  model: ResolvedModel,
): Promise<void> {
  if (!model.modelId && !model.effort && !model.modeId) return;

  if (model.modelId) {
    try {
      await connection.setSessionConfigOption({
        sessionId,
        configId: "model",
        value: model.modelId,
      });
    } catch {
      try {
        await (connection as unknown as { request: (m: string, p: unknown) => Promise<unknown> }).request(
          "session/set_model",
          { sessionId, modelId: model.modelId },
        );
      } catch {
        try {
          await (connection as unknown as { request: (m: string, p: unknown) => Promise<unknown> }).request(
            "session/setModel",
            { sessionId, modelId: model.modelId },
          );
        } catch {
          // agent may not support model switching
        }
      }
    }
  }

  if (model.effort) {
    try {
      await connection.setSessionConfigOption({
        sessionId,
        configId: "effort",
        value: model.effort,
      });
    } catch {
      // ignore
    }
  }

  if (model.modeId) {
    try {
      await connection.setSessionMode({ sessionId, modeId: model.modeId });
    } catch {
      // ignore
    }
  }
}
