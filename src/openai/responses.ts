import type { ChatMessage } from "../util/messages.ts";
import { contentToText } from "../util/messages.ts";
import type { FinishReason } from "./completion-meta.ts";
import type { OpenAIToolCall } from "./tools.ts";
import type { TokenUsage } from "../types.ts";

/** Convert Responses API `input` + instructions into chat messages. */
export function responsesInputToMessages(opts: {
  input?: unknown;
  instructions?: string;
  messages?: ChatMessage[];
}): ChatMessage[] {
  if (Array.isArray(opts.messages) && opts.messages.length) {
    const out = [...opts.messages];
    if (opts.instructions) {
      out.unshift({ role: "system", content: opts.instructions });
    }
    return out;
  }

  const out: ChatMessage[] = [];
  if (opts.instructions) out.push({ role: "system", content: opts.instructions });

  const input = opts.input;
  if (input == null) {
    if (!out.length) out.push({ role: "user", content: "Hello" });
    return out;
  }

  if (typeof input === "string") {
    out.push({ role: "user", content: input });
    return out;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        out.push({ role: "user", content: item });
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      // message-shaped
      if (rec.role || rec.content != null) {
        out.push({
          role: String(rec.role ?? "user"),
          content: rec.content ?? rec.text,
          name: typeof rec.name === "string" ? rec.name : undefined,
          tool_call_id: typeof rec.tool_call_id === "string" ? rec.tool_call_id : undefined,
          tool_calls: rec.tool_calls as unknown,
        });
        continue;
      }
      const type = String(rec.type ?? "").toLowerCase();
      if (type === "message" || type === "input_text" || type === "text") {
        const role = String(rec.role ?? "user");
        const content = rec.content ?? rec.text ?? "";
        out.push({ role, content });
      } else if (type === "function_call_output" || type === "tool_result") {
        out.push({
          role: "tool",
          tool_call_id: String(rec.call_id ?? rec.tool_call_id ?? ""),
          content: rec.output ?? rec.content ?? "",
        });
      } else {
        const text = contentToText(rec);
        if (text) out.push({ role: "user", content: text });
      }
    }
    if (!out.some((m) => String(m.role).toLowerCase() !== "system")) {
      out.push({ role: "user", content: "Hello" });
    }
    return out;
  }

  if (typeof input === "object") {
    const text = contentToText(input);
    out.push({ role: "user", content: text || JSON.stringify(input) });
    return out;
  }

  out.push({ role: "user", content: String(input) });
  return out;
}

export function buildResponsesObject(opts: {
  id: string;
  model: string;
  content: string;
  finishReason: FinishReason;
  usage: TokenUsage;
  tool_calls?: OpenAIToolCall[];
  created?: number;
}) {
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  const output: unknown[] = [];

  if (opts.tool_calls?.length) {
    for (const tc of opts.tool_calls) {
      output.push({
        type: "function_call",
        id: tc.id,
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      });
    }
  }

  output.push({
    type: "message",
    id: `msg_${opts.id.replace(/^resp_/, "").slice(0, 12)}`,
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text: opts.content || "",
      },
    ],
  });

  const status =
    opts.finishReason === "tool_calls" || opts.finishReason === "function_call"
      ? "requires_action"
      : "completed";

  return {
    id: opts.id,
    object: "response",
    created_at: created,
    status,
    error: null,
    incomplete_details: opts.finishReason === "length" ? { reason: "max_output_tokens" } : null,
    model: opts.model,
    output,
    usage: {
      input_tokens: opts.usage.prompt_tokens,
      output_tokens: opts.usage.completion_tokens,
      total_tokens: opts.usage.total_tokens,
    },
    // non-standard bridge metadata
    acp_to_api: {
      finish_reason: opts.finishReason,
      mapped_from: "chat.completions",
    },
  };
}
