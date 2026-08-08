import { contentToText } from "../util/messages.ts";

export type OpenAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ClientToolSpec = {
  name: string;
  description?: string;
  parameters?: unknown;
};

export function parseClientTools(tools: unknown[] | undefined): ClientToolSpec[] {
  if (!Array.isArray(tools)) return [];
  const out: ClientToolSpec[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const t = tool as Record<string, unknown>;
    if (String(t.type ?? "") === "function" && t.function && typeof t.function === "object") {
      const fn = t.function as Record<string, unknown>;
      if (typeof fn.name === "string" && fn.name) {
        out.push({
          name: fn.name,
          description: typeof fn.description === "string" ? fn.description : undefined,
          parameters: fn.parameters,
        });
      }
    }
  }
  return out;
}

export function formatToolChoice(toolChoice: unknown): string | null {
  if (toolChoice == null) return null;
  if (typeof toolChoice === "string") {
    const v = toolChoice.toLowerCase();
    if (v === "none") return "Do not call tools; answer with text only.";
    if (v === "auto") return "You may use tools when helpful.";
    if (v === "required") return "You must use at least one tool before finishing.";
    return `tool_choice=${toolChoice}`;
  }
  if (typeof toolChoice === "object") {
    const rec = toolChoice as Record<string, unknown>;
    if (String(rec.type ?? "") === "function" && rec.function && typeof rec.function === "object") {
      const name = (rec.function as Record<string, unknown>).name;
      if (typeof name === "string" && name) {
        return `You must call the function tool named "${name}".`;
      }
    }
  }
  return null;
}

/** Build prompt section describing client tools + tool_choice policy. */
export function buildToolsPromptSection(tools: unknown[] | undefined, toolChoice?: unknown): string {
  const specs = parseClientTools(tools);
  const choiceLine = formatToolChoice(toolChoice);
  if (!specs.length && !choiceLine) return "";

  const lines: string[] = ["", "OpenAI client tools (protocol bridge — best-effort):"];
  if (choiceLine) lines.push(`- tool_choice: ${choiceLine}`);
  if (specs.length) {
    lines.push("- Available function tools (JSON schemas). Prefer ACP workspace tools for file/shell work;");
    lines.push("  if you need the *client* to run a function, emit a final JSON block:");
    lines.push('  {"tool_calls":[{"id":"call_1","type":"function","function":{"name":"...","arguments":"{...}"}}]}');
    for (const s of specs) {
      const params = s.parameters != null ? JSON.stringify(s.parameters) : "{}";
      lines.push(
        `  • ${s.name}${s.description ? `: ${s.description}` : ""} parameters=${params}`,
      );
    }
  }
  return lines.join("\n");
}

function safeJsonStringify(value: unknown): string {
  try {
    if (typeof value === "string") {
      // If already JSON object/array string, keep; else wrap as JSON string value
      const t = value.trim();
      if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
        JSON.parse(t);
        return t;
      }
      return JSON.stringify(value);
    }
    return JSON.stringify(value ?? {});
  } catch {
    return JSON.stringify(String(value ?? ""));
  }
}

function toolNameFromAcp(tool: {
  title?: string;
  kind?: string;
  rawInput?: unknown;
}): string {
  if (tool.title && /^[a-zA-Z0-9_.-]+$/.test(tool.title)) return tool.title;
  const kind = (tool.kind ?? "tool").replace(/[^a-zA-Z0-9_.-]+/g, "_");
  return kind || "acp_tool";
}

/** Map ACP session tool events into OpenAI tool_calls when possible. */
export function acpToolsToOpenAIToolCalls(
  tools: Array<{
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: string;
    rawInput?: unknown;
    content?: unknown;
  }>,
): OpenAIToolCall[] {
  const out: OpenAIToolCall[] = [];
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i]!;
    // Prefer completed or pending tool_call with input
    const id = t.toolCallId || `call_${i + 1}`;
    let args: unknown = t.rawInput;
    if (args == null && t.content != null) {
      const text = contentToText(t.content).trim();
      if (text) {
        try {
          args = JSON.parse(text);
        } catch {
          args = { content: text };
        }
      }
    }
    if (args == null) args = {};
    out.push({
      id: String(id),
      type: "function",
      function: {
        name: toolNameFromAcp(t),
        arguments: safeJsonStringify(args),
      },
    });
  }
  return out;
}

/**
 * If assistant text embeds a tool_calls JSON payload, extract it.
 * Returns remaining text + tool_calls.
 */
export function extractEmbeddedToolCalls(text: string): {
  text: string;
  tool_calls: OpenAIToolCall[];
} {
  const trimmed = text.trim();
  if (!trimmed) return { text: "", tool_calls: [] };

  // fenced or raw JSON with tool_calls
  const candidates: string[] = [];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) candidates.push(fence[1].trim());
  candidates.push(trimmed);

  const start = trimmed.indexOf('{"tool_calls"');
  const start2 = trimmed.indexOf('{ "tool_calls"');
  const s = start >= 0 ? start : start2;
  if (s >= 0) candidates.push(trimmed.slice(s));

  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as Record<string, unknown>;
      if (!obj || typeof obj !== "object") continue;
      const tc = obj.tool_calls;
      if (!Array.isArray(tc) || !tc.length) continue;
      const tool_calls: OpenAIToolCall[] = [];
      for (const item of tc) {
        if (!item || typeof item !== "object") continue;
        const rec = item as Record<string, unknown>;
        const fn = rec.function && typeof rec.function === "object"
          ? (rec.function as Record<string, unknown>)
          : null;
        const name = fn && typeof fn.name === "string" ? fn.name : null;
        if (!name) continue;
        const args = fn?.arguments;
        tool_calls.push({
          id: typeof rec.id === "string" ? rec.id : `call_${tool_calls.length + 1}`,
          type: "function",
          function: {
            name,
            arguments:
              typeof args === "string" ? args : safeJsonStringify(args ?? {}),
          },
        });
      }
      if (!tool_calls.length) continue;
      // strip the JSON from visible content when whole message was the payload
      let rest = trimmed;
      if (rest === c || rest.includes(c)) rest = rest.replace(c, "").replace(/```json|```/g, "").trim();
      return { text: rest, tool_calls };
    } catch {
      // continue
    }
  }
  return { text: trimmed, tool_calls: [] };
}

export function mergeToolCalls(
  fromAcp: OpenAIToolCall[],
  fromText: OpenAIToolCall[],
): OpenAIToolCall[] {
  if (!fromAcp.length) return fromText;
  if (!fromText.length) return fromAcp;
  const seen = new Set(fromAcp.map((t) => t.id));
  const out = [...fromAcp];
  for (const t of fromText) {
    if (!seen.has(t.id)) out.push(t);
  }
  return out;
}
