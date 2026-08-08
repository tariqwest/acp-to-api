import type { TokenUsage } from "../types.ts";

/** OpenAI chat.completion finish_reason values we emit. */
export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "function_call";

export type StreamOptions = {
  include_usage?: boolean;
};

/**
 * Map ACP / agent stopReason strings to OpenAI finish_reason.
 * ACP commonly uses end_turn; some agents use max_tokens, cancelled, etc.
 */
export function mapStopReason(reason: string | undefined | null): FinishReason {
  if (!reason) return "stop";
  const r = reason.toLowerCase().replace(/[\s-]+/g, "_");

  if (
    r.includes("content_filter") ||
    r.includes("contentfilter") ||
    r.includes("safety") ||
    r.includes("refusal") ||
    r.includes("blocked") ||
    r.includes("moderation")
  ) {
    return "content_filter";
  }

  if (
    r.includes("max_token") ||
    r.includes("max_output") ||
    r.includes("max_length") ||
    r === "length" ||
    r.includes("token_limit") ||
    r.includes("output_limit") ||
    (r.includes("length") && !r.includes("end"))
  ) {
    return "length";
  }

  // OpenAI tool_calls / legacy function_call. Prefer tool_calls for modern clients.
  if (
    r.includes("tool_call") ||
    r.includes("tool_use") ||
    r === "tool" ||
    r.includes("function_call") ||
    r.includes("functions")
  ) {
    if (r.includes("function") && !r.includes("tool")) return "function_call";
    return "tool_calls";
  }

  // cancelled / abort / end_turn / stop / error → stop (honest: no separate cancel finish_reason)
  return "stop";
}

/**
 * If the client requested max_tokens and the agent stopped for an unknown reason
 * with empty or truncated-looking output, keep agent mapping; only force length when
 * stopReason already indicates length or max_tokens was hit via agent signal.
 */
export function refineFinishReason(
  mapped: FinishReason,
  opts: { maxTokens?: number; completionChars?: number; stopReason?: string },
): FinishReason {
  if (mapped !== "stop") return mapped;
  // Some agents omit a length stopReason; if max_tokens is tiny and output is large, still don't guess.
  void opts;
  return mapped;
}

export function zeroUsage(): TokenUsage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

/** Normalize partial usage objects; ensure totals are consistent when possible. */
export function normalizeUsage(usage: TokenUsage | null | undefined): TokenUsage {
  if (!usage) return zeroUsage();
  const prompt = Math.max(0, Math.floor(Number(usage.prompt_tokens) || 0));
  const completion = Math.max(0, Math.floor(Number(usage.completion_tokens) || 0));
  let total = Math.max(0, Math.floor(Number(usage.total_tokens) || 0));
  if (total === 0 && (prompt > 0 || completion > 0)) total = prompt + completion;
  if (total < prompt + completion && prompt + completion > 0) total = prompt + completion;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

/**
 * Estimate completion_tokens from UTF-16 length when ACP only reports context `used`.
 * Rough ~4 chars/token heuristic; only fills completion when it is still 0 and text exists.
 */
export function estimateUsageFromText(
  usage: TokenUsage | null | undefined,
  assistantText: string,
): TokenUsage {
  const base = normalizeUsage(usage);
  if (!assistantText) return base;
  if (base.completion_tokens > 0) return base;
  const est = Math.max(1, Math.ceil(assistantText.length / 4));
  const completion_tokens = est;
  // If prompt_tokens looks like full context used, derive prompt as used - completion when plausible.
  let prompt_tokens = base.prompt_tokens;
  let total_tokens = base.total_tokens;
  if (total_tokens >= completion_tokens && prompt_tokens === total_tokens) {
    prompt_tokens = Math.max(0, total_tokens - completion_tokens);
  } else if (total_tokens === 0) {
    total_tokens = prompt_tokens + completion_tokens;
  } else if (total_tokens < prompt_tokens + completion_tokens) {
    total_tokens = prompt_tokens + completion_tokens;
  }
  return { prompt_tokens, completion_tokens, total_tokens };
}

export type ChatChoiceMessage = {
  role: "assistant";
  content: string | null;
  refusal?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

export type NonStreamChoice = {
  index: number;
  message: ChatChoiceMessage;
  finish_reason: FinishReason;
  logprobs: null;
};

export type StreamChoice = {
  index: number;
  delta: Record<string, unknown>;
  finish_reason: FinishReason | null;
  logprobs: null;
};

export function buildNonStreamChoice(opts: {
  content: string | null;
  finishReason: FinishReason;
  index?: number;
  refusal?: string | null;
  tool_calls?: ChatChoiceMessage["tool_calls"];
}): NonStreamChoice {
  const message: ChatChoiceMessage = {
    role: "assistant",
    content: opts.content,
    refusal: opts.refusal ?? null,
  };
  if (opts.tool_calls?.length) message.tool_calls = opts.tool_calls;
  return {
    index: opts.index ?? 0,
    message,
    finish_reason: opts.finishReason,
    logprobs: null,
  };
}

export function buildStreamChoice(opts: {
  delta?: Record<string, unknown>;
  finishReason?: FinishReason | null;
  index?: number;
}): StreamChoice {
  return {
    index: opts.index ?? 0,
    delta: opts.delta ?? {},
    finish_reason: opts.finishReason === undefined ? null : opts.finishReason,
    logprobs: null,
  };
}

/** OpenAI-style final usage-only chunk when stream_options.include_usage is true. */
export function shouldIncludeStreamUsage(streamOptions: StreamOptions | undefined): boolean {
  // Default true for gateway compatibility (clients already expect usage on final chunk).
  if (!streamOptions) return true;
  if (streamOptions.include_usage === false) return false;
  return true;
}
