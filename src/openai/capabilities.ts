/**
 * Honest OpenAI-compat capability matrix for acp-to-api.
 * Clients and model cards should treat this as the source of truth for
 * what is enforced vs ignored vs best-effort.
 */

export type SupportLevel = "enforced" | "best_effort" | "ignored" | "unsupported";

export type CapabilityEntry = {
  id: string;
  level: SupportLevel;
  notes: string;
};

export const CAPABILITY_MATRIX: CapabilityEntry[] = [
  {
    id: "chat.completions",
    level: "best_effort",
    notes: "Mapped to ACP agent session turns; not pure model inference.",
  },
  {
    id: "models.list",
    level: "enforced",
    notes: "Agent/model discovery catalog.",
  },
  {
    id: "streaming.sse",
    level: "best_effort",
    notes: "Text deltas from agent updates; may be coarse-grained.",
  },
  {
    id: "response_format.json_object",
    level: "best_effort",
    notes: "Prompt + extract + validate; not constrained decoding.",
  },
  {
    id: "response_format.json_schema",
    level: "best_effort",
    notes: "Ajv validate + one repair turn; strict defaults true.",
  },
  {
    id: "tools.protocol",
    level: "best_effort",
    notes:
      "Client tools become prompt specs; ACP tool events may surface as OpenAI tool_calls when mappable. Client-executed tools are not a full round-trip runtime.",
  },
  {
    id: "tool_choice",
    level: "best_effort",
    notes: "Encoded into prompt instructions only.",
  },
  {
    id: "finish_reason",
    level: "best_effort",
    notes: "Mapped from ACP stopReason + tool activity.",
  },
  {
    id: "usage",
    level: "best_effort",
    notes: "From ACP usage_update when present; completion may be estimated.",
  },
  {
    id: "stream_options.include_usage",
    level: "enforced",
    notes: "Controls whether usage appears on the final stream chunk (default on).",
  },
  {
    id: "n",
    level: "enforced",
    notes: "Only n=1; n>1 rejected.",
  },
  {
    id: "temperature",
    level: "ignored",
    notes: "Accepted for client compatibility; not applied to ACP agents.",
  },
  {
    id: "max_tokens",
    level: "ignored",
    notes: "Accepted; not enforced as model sampling limit.",
  },
  {
    id: "logprobs",
    level: "unsupported",
    notes: "Always null.",
  },
  {
    id: "vision.image_url",
    level: "unsupported",
    notes: "Non-text parts become text placeholders unless agent handles paths.",
  },
  {
    id: "embeddings",
    level: "unsupported",
    notes: "No /v1/embeddings.",
  },
  {
    id: "responses.api",
    level: "best_effort",
    notes: "Subset of POST /v1/responses mapped onto chat/ACP.",
  },
  {
    id: "assistants.api",
    level: "unsupported",
    notes: "Not implemented.",
  },
];

export type ModelCapabilityCard = {
  object: "acp_to_api.capabilities";
  version: 1;
  gateway: "acp-to-api";
  matrix: CapabilityEntry[];
  summary: {
    enforced: string[];
    best_effort: string[];
    ignored: string[];
    unsupported: string[];
  };
};

export function buildCapabilityCard(): ModelCapabilityCard {
  const summary = {
    enforced: CAPABILITY_MATRIX.filter((c) => c.level === "enforced").map((c) => c.id),
    best_effort: CAPABILITY_MATRIX.filter((c) => c.level === "best_effort").map((c) => c.id),
    ignored: CAPABILITY_MATRIX.filter((c) => c.level === "ignored").map((c) => c.id),
    unsupported: CAPABILITY_MATRIX.filter((c) => c.level === "unsupported").map((c) => c.id),
  };
  return {
    object: "acp_to_api.capabilities",
    version: 1,
    gateway: "acp-to-api",
    matrix: CAPABILITY_MATRIX,
    summary,
  };
}

/** Fields attached to each /v1/models entry for honest client discovery. */
export function modelCardExtras() {
  return {
    capabilities: {
      chat_completions: true,
      streaming: true,
      tools: "best_effort" as const,
      structured_outputs: "best_effort" as const,
      vision: false,
      logprobs: false,
      n: 1,
      responses_api: "subset" as const,
    },
    sampling: {
      temperature: "ignored",
      max_tokens: "ignored",
      top_p: "ignored",
    },
  };
}
