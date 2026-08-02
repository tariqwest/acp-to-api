import type { TokenUsage } from "../types.ts";

export function pickPermissionOptionId(
  options: Array<{ optionId?: string; kind?: string } | Record<string, unknown>>,
): string | null {
  const normalized = (options ?? []).map((opt) => {
    const o = opt as Record<string, unknown>;
    return {
      optionId: String(o.optionId ?? o.option_id ?? "").trim(),
      kind: String(o.kind ?? "").trim().toLowerCase(),
    };
  });

  for (const preferred of ["allow_always", "allow_once", "proceed_always", "proceed_once"]) {
    const hit = normalized.find((o) => o.kind === preferred && o.optionId);
    if (hit) return hit.optionId;
  }
  const allowish = normalized.find((o) => o.optionId && o.kind.includes("allow"));
  if (allowish) return allowish.optionId;
  return normalized.find((o) => o.optionId)?.optionId ?? null;
}

export function sessionUpdateText(update: unknown): string {
  if (!update || typeof update !== "object") return "";
  const data = update as Record<string, unknown>;
  const kind = String(data.sessionUpdate ?? data.session_update ?? "").trim();
  if (kind !== "agent_message_chunk") return "";
  return contentBlockToText(data.content);
}

export function sessionUpdateUsage(update: unknown): TokenUsage | null {
  if (!update || typeof update !== "object") return null;
  const data = update as Record<string, unknown>;
  const kind = String(data.sessionUpdate ?? data.session_update ?? "").trim();
  if (kind !== "usage_update") return null;

  // ACP usage_update is context-window oriented (used/size), not OpenAI prompt/completion.
  const used = Number(data.used ?? 0);
  if (!Number.isFinite(used) || used < 0) return null;
  return {
    prompt_tokens: Math.floor(used),
    completion_tokens: 0,
    total_tokens: Math.floor(used),
  };
}

export function sessionUpdateTool(update: unknown): {
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  content?: unknown;
} | null {
  if (!update || typeof update !== "object") return null;
  const data = update as Record<string, unknown>;
  const kind = String(data.sessionUpdate ?? data.session_update ?? "").trim();
  if (kind !== "tool_call" && kind !== "tool_call_update") return null;

  const toolCallId = data.toolCallId ?? data.tool_call_id;
  return {
    toolCallId: toolCallId != null ? String(toolCallId) : undefined,
    title: data.title != null ? String(data.title) : undefined,
    kind: data.kind != null ? String(data.kind) : kind,
    status: data.status != null ? String(data.status) : kind === "tool_call" ? "pending" : undefined,
    rawInput: data.rawInput ?? data.raw_input,
    content: data.content,
  };
}

function contentBlockToText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentBlockToText).join("");
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (rec.type === "text" || typeof rec.text === "string") return String(rec.text ?? "");
    if ("content" in rec) return contentBlockToText(rec.content);
  }
  return "";
}

/** Extract model ids from NewSessionResponse.configOptions */
export function extractModelsFromConfigOptions(configOptions: unknown): Array<{ id: string; name?: string }> {
  if (!Array.isArray(configOptions)) return [];
  const out: Array<{ id: string; name?: string }> = [];
  const seen = new Set<string>();

  for (const opt of configOptions) {
    if (!opt || typeof opt !== "object") continue;
    const o = opt as Record<string, unknown>;
    const id = String(o.id ?? "").toLowerCase();
    const category = String(o.category ?? "").toLowerCase();
    const type = String(o.type ?? "").toLowerCase();
    const isModel =
      type === "select" && (id === "model" || category === "model" || id.includes("model"));
    if (!isModel) continue;

    collectSelectValues(o.options, out, seen);
  }
  return out;
}

function collectSelectValues(
  options: unknown,
  out: Array<{ id: string; name?: string }>,
  seen: Set<string>,
) {
  if (!Array.isArray(options)) return;
  for (const item of options) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.value === "string" && rec.value) {
      if (!seen.has(rec.value)) {
        seen.add(rec.value);
        out.push({ id: rec.value, name: typeof rec.name === "string" ? rec.name : undefined });
      }
      continue;
    }
    // group form: { group, name, options: [...] }
    if (Array.isArray(rec.options)) collectSelectValues(rec.options, out, seen);
  }
}
