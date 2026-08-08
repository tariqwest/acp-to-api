import AjvModule, { type ErrorObject, type ValidateFunction } from "ajv";
import type { ResponseFormat } from "../openai/schema.ts";

// Ajv CJS/ESM interop (Node + Bun).
const AjvCtor =
  (AjvModule as unknown as { default?: new (opts?: object) => { compile: (schema: object) => ValidateFunction } })
    .default ??
  (AjvModule as unknown as new (opts?: object) => { compile: (schema: object) => ValidateFunction });

export type StructuredOutputMode = "json_object" | "json_schema";

export type StructuredOutputSpec = {
  mode: StructuredOutputMode;
  /** OpenAI json_schema.name when mode is json_schema */
  name?: string;
  /**
   * When true (default for json_schema unless strict:false), invalid output is an error
   * after an optional one-shot repair attempt.
   */
  strict: boolean;
  schema?: Record<string, unknown>;
};

export type StructureResult =
  | { ok: true; text: string; value: unknown }
  | { ok: false; text: string; error: string; value?: unknown };

const ajv = new AjvCtor({
  allErrors: true,
  strict: false,
  validateSchema: false,
});

const validatorCache = new Map<string, ValidateFunction>();

export function responseFormatToSpec(
  responseFormat: ResponseFormat | undefined,
): StructuredOutputSpec | null {
  if (!responseFormat || responseFormat.type === "text") return null;
  if (responseFormat.type === "json_object") {
    return { mode: "json_object", strict: true };
  }
  if (responseFormat.type === "json_schema") {
    const js = responseFormat.json_schema;
    return {
      mode: "json_schema",
      name: js.name,
      strict: js.strict !== false,
      schema: js.schema as Record<string, unknown>,
    };
  }
  return null;
}

/** Instruction block appended to the ACP prompt so the agent emits parseable JSON. */
export function structuredOutputInstructions(spec: StructuredOutputSpec): string {
  if (spec.mode === "json_object") {
    return [
      "Structured output requirements:",
      "- Respond with a single JSON object only.",
      "- Do not wrap the JSON in markdown fences.",
      "- Do not include prose before or after the JSON.",
      "- The entire assistant message must be valid JSON.",
    ].join("\n");
  }

  const schemaText = JSON.stringify(spec.schema ?? {}, null, 2);
  const nameLine = spec.name ? `Schema name: ${spec.name}` : "Schema name: (unnamed)";
  return [
    "Structured output requirements:",
    "- Respond with a single JSON value that validates against the schema below.",
    "- Do not wrap the JSON in markdown fences.",
    "- Do not include prose before or after the JSON.",
    `- ${nameLine}`,
    `- Strict mode: ${spec.strict ? "on (invalid JSON is an error)" : "off"}`,
    "JSON Schema:",
    schemaText,
  ].join("\n");
}

export function appendStructuredOutputInstructions(
  prompt: string,
  spec: StructuredOutputSpec | null,
): string {
  if (!spec) return prompt;
  const block = structuredOutputInstructions(spec);
  if (!prompt.trim()) return block;
  return `${prompt.trimEnd()}\n\n${block}`;
}

/**
 * Extract a JSON value from model/agent text.
 * Prefers fenced ```json blocks, then first balanced JSON object/array span.
 */
export function extractJsonCandidate(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fence = trimmed.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    const inner = fence[1].trim();
    if (inner) return inner;
  }

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return trimmed;
  }

  const startObj = trimmed.indexOf("{");
  const startArr = trimmed.indexOf("[");
  let start = -1;
  if (startObj >= 0 && startArr >= 0) start = Math.min(startObj, startArr);
  else start = Math.max(startObj, startArr);
  if (start < 0) return null;

  return extractBalancedJson(trimmed.slice(start));
}

function extractBalancedJson(input: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  const pairs: Record<string, string> = { "{": "}", "[": "]" };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }
    if (ch === "}" || ch === "]") {
      const last = stack.pop();
      if (!last || pairs[last] !== ch) return null;
      if (stack.length === 0) return input.slice(0, i + 1);
    }
  }
  return null;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return "JSON Schema validation failed";
  return errors
    .map((e) => {
      const path = e.instancePath || "/";
      return `${path} ${e.message ?? "invalid"}`.trim();
    })
    .join("; ");
}

function getValidator(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  let v = validatorCache.get(key);
  if (!v) {
    v = ajv.compile(schema);
    validatorCache.set(key, v);
  }
  return v;
}

/** Parse + validate assistant text against a structured-output spec. */
export function structureAssistantText(text: string, spec: StructuredOutputSpec): StructureResult {
  const candidate = extractJsonCandidate(text);
  if (!candidate) {
    return {
      ok: false,
      text,
      error: "Assistant output did not contain a JSON object or array",
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch (err) {
    return {
      ok: false,
      text,
      error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (spec.mode === "json_object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return {
        ok: false,
        text: candidate,
        value,
        error: "response_format=json_object requires a JSON object",
      };
    }
    return { ok: true, text: JSON.stringify(value), value };
  }

  if (!spec.schema || typeof spec.schema !== "object") {
    return {
      ok: false,
      text: candidate,
      value,
      error: "response_format.json_schema.schema is required",
    };
  }

  try {
    const validate = getValidator(spec.schema);
    const valid = validate(value);
    if (!valid) {
      return {
        ok: false,
        text: candidate,
        value,
        error: formatAjvErrors(validate.errors),
      };
    }
  } catch (err) {
    return {
      ok: false,
      text: candidate,
      value,
      error: `Schema compilation/validation error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { ok: true, text: JSON.stringify(value), value };
}

/** One-shot repair prompt when first output fails validation. */
export function repairStructuredOutputPrompt(
  spec: StructuredOutputSpec,
  error: string,
  previous: string,
): string {
  const base = structuredOutputInstructions(spec);
  return [
    "Your previous answer failed structured-output validation.",
    `Validation error: ${error}`,
    "Previous answer:",
    previous.slice(0, 8000),
    "",
    "Emit a corrected response that satisfies the requirements below.",
    base,
  ].join("\n");
}
