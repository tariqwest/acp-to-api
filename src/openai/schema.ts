import { z } from "zod";

export const ChatMessageSchema = z.object({
  role: z.string().optional(),
  content: z.unknown().optional(),
  name: z.string().optional(),
});

export const ChatCompletionsRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(ChatMessageSchema).default([]),
  stream: z.boolean().optional().default(false),
  tools: z.array(z.unknown()).optional(),
  user: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // common passthroughs we may honor
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
});

export type ChatCompletionsRequest = z.infer<typeof ChatCompletionsRequestSchema>;

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

export function toSseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}
