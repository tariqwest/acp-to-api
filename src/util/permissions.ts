import type { TokenUsage } from "../types.ts";

export function pickPermissionOptionId(
  options: Array<{ optionId?: string; kind?: string } | Record<string, unknown>>,
): string | null {
  const normalized = (options ?? []).map((opt) => {
    const o = opt as Record<string, unknown>;
    return {
      optionId: String(o.optionId ?? o.option_id ?? o.id ?? "").trim(),
      kind: String(o.kind ?? o.type ?? "").trim().toLowerCase(),
      name: String(o.name ?? o.label ?? o.description ?? "").trim().toLowerCase(),
    };
  });

  // Priority 1: standard ACP permission kinds
  for (const preferred of ["allow_always", "allow_once", "proceed_always", "proceed_once"]) {
    const hit = normalized.find((o) => o.kind === preferred && o.optionId);
    if (hit) return hit.optionId;
  }

  // Priority 2: kind/type containing allow, proceed, yes, approve
  const allowishKind = normalized.find(
    (o) =>
      o.optionId &&
      (o.kind.includes("allow") ||
        o.kind.includes("proceed") ||
        o.kind.includes("yes") ||
        o.kind.includes("approve")),
  );
  if (allowishKind) return allowishKind.optionId;

  // Priority 3: name/label/description containing affirmative keywords
  const allowishName = normalized.find(
    (o) =>
      o.optionId &&
      (o.name.includes("allow") ||
        o.name.includes("yes") ||
        o.name.includes("approve") ||
        o.name.includes("proceed") ||
        o.name.includes("always") ||
        o.name.includes("once")),
  );
  if (allowishName) return allowishName.optionId;

  // Priority 4: first option that is not explicitly deny/reject/cancel
  const nonDeny = normalized.find(
    (o) =>
      o.optionId &&
      !o.kind.includes("deny") &&
      !o.kind.includes("reject") &&
      !o.kind.includes("cancel") &&
      !o.name.includes("deny") &&
      !o.name.includes("cancel"),
  );
  if (nonDeny) return nonDeny.optionId;

  // Fallback: first option with a valid optionId
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
  if (kind !== "usage_update" && kind !== "usage") {
    // Some agents nest usage on other updates
    if (!("usage" in data) && data.used == null && data.prompt_tokens == null) return null;
    if (kind && kind !== "usage_update" && kind !== "usage" && !("usage" in data)) return null;
  }

  const nested =
    data.usage && typeof data.usage === "object" ? (data.usage as Record<string, unknown>) : null;
  const src = nested ?? data;

  const num = (...keys: string[]): number | null => {
    for (const k of keys) {
      const v = src[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
      if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
        const n = Math.floor(Number(v));
        if (n >= 0) return n;
      }
    }
    return null;
  };

  // Prefer explicit OpenAI-shaped fields when agents provide them.
  let prompt = num("prompt_tokens", "input_tokens", "promptTokens", "inputTokens");
  let completion = num(
    "completion_tokens",
    "output_tokens",
    "completionTokens",
    "outputTokens",
  );
  let total = num("total_tokens", "totalTokens", "tokens");

  // ACP usage_update is often context-window oriented (used/size).
  const used = num("used", "context_used", "contextUsed");
  if (prompt == null && used != null) prompt = used;
  if (total == null && used != null) total = used;

  if (prompt == null && completion == null && total == null) return null;

  prompt = prompt ?? 0;
  completion = completion ?? 0;
  if (total == null) total = prompt + completion;
  if (total < prompt + completion && prompt + completion > 0) total = prompt + completion;

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
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
