import { z } from "zod";

export const ChatMessageSchema = z.object({
  role: z.string().optional(),
  content: z.unknown().optional(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.unknown()).optional(),
  function_call: z.unknown().optional(),
});

/** OpenAI-compatible response_format (best-effort over ACP agents). */
export const ResponseFormatSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text") }),
  z.object({ type: z.literal("json_object") }),
  z.object({
    type: z.literal("json_schema"),
    json_schema: z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      schema: z.record(z.string(), z.unknown()),
      strict: z.boolean().optional(),
    }),
  }),
]);

export type ResponseFormat = z.infer<typeof ResponseFormatSchema>;

export const StreamOptionsSchema = z
  .object({
    include_usage: z.boolean().optional(),
  })
  .optional();

export const ToolChoiceSchema = z.union([
  z.enum(["none", "auto", "required"]),
  z.string(),
  z.record(z.string(), z.unknown()),
]).optional();

export const ChatCompletionsRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).default([]),
  stream: z.boolean().optional().default(false),
  stream_options: StreamOptionsSchema,
  tools: z.array(z.unknown()).optional(),
  tool_choice: ToolChoiceSchema,
  user: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // common passthroughs we may honor
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  max_completion_tokens: z.number().optional(),
  /** Multiple choices are not supported (ACP is single-agent turn). Only n=1. */
  n: z.number().int().positive().optional().default(1),
  response_format: ResponseFormatSchema.optional(),
});

export type ChatCompletionsRequest = z.infer<typeof ChatCompletionsRequestSchema>;

/** Subset of OpenAI Responses API request fields. */
export const ResponsesRequestSchema = z.object({
  model: z.string().min(1),
  input: z.unknown().optional(),
  instructions: z.string().optional(),
  messages: z.array(ChatMessageSchema).optional(),
  stream: z.boolean().optional().default(false),
  tools: z.array(z.unknown()).optional(),
  tool_choice: ToolChoiceSchema,
  temperature: z.number().optional(),
  max_output_tokens: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  user: z.string().optional(),
  // store not implemented; accepted
  store: z.boolean().optional(),
});

export type ResponsesRequest = z.infer<typeof ResponsesRequestSchema>;

export function openaiError(status: number, message: string, type = "invalid_request_error") {
  return Response.json(
    {
      error: {
        message,
        type,
        param: null,
        code: null,
      },
    },
    { status },
  );
}

export function completionId() {
  return `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function responseId() {
  return `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export function toSseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
