import { describe, expect, it } from "bun:test";
import {
  appendStructuredOutputInstructions,
  extractJsonCandidate,
  responseFormatToSpec,
  structureAssistantText,
  structuredOutputInstructions,
} from "./structured-output.ts";
import type { ResponseFormat } from "../openai/schema.ts";

describe("structured-output", () => {
  describe("responseFormatToSpec", () => {
    it("returns null for missing or text", () => {
      expect(responseFormatToSpec(undefined)).toBeNull();
      expect(responseFormatToSpec({ type: "text" })).toBeNull();
    });

    it("maps json_object", () => {
      expect(responseFormatToSpec({ type: "json_object" })).toEqual({
        mode: "json_object",
        strict: true,
      });
    });

    it("maps json_schema with default strict", () => {
      const rf: ResponseFormat = {
        type: "json_schema",
        json_schema: {
          name: "item",
          schema: { type: "object", properties: { a: { type: "string" } } },
        },
      };
      const spec = responseFormatToSpec(rf)!;
      expect(spec.mode).toBe("json_schema");
      expect(spec.strict).toBe(true);
      expect(spec.name).toBe("item");
    });

    it("honors strict:false", () => {
      const rf: ResponseFormat = {
        type: "json_schema",
        json_schema: {
          name: "item",
          schema: { type: "object" },
          strict: false,
        },
      };
      expect(responseFormatToSpec(rf)?.strict).toBe(false);
    });
  });

  describe("extractJsonCandidate", () => {
    it("extracts raw object", () => {
      expect(extractJsonCandidate('  {"a":1}  ')).toBe('{"a":1}');
    });

    it("extracts fenced json", () => {
      const text = ["Here:", "```json", '{"a":2}', "```", ""].join("\n");
      expect(extractJsonCandidate(text)).toBe('{"a":2}');
    });

    it("extracts first balanced object in prose", () => {
      expect(extractJsonCandidate('say {"x":true} please')).toBe('{"x":true}');
    });

    it("handles nested braces", () => {
      expect(extractJsonCandidate('pre {"a":{"b":1}} post')).toBe('{"a":{"b":1}}');
    });

    it("returns null when none", () => {
      expect(extractJsonCandidate("no json here")).toBeNull();
    });
  });

  describe("structureAssistantText", () => {
    it("validates json_object", () => {
      const r = structureAssistantText('{"ok":true}', { mode: "json_object", strict: true });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.text).toBe('{"ok":true}');
    });

    it("rejects arrays for json_object", () => {
      const r = structureAssistantText("[1]", { mode: "json_object", strict: true });
      expect(r.ok).toBe(false);
    });

    it("validates json_schema with Ajv", () => {
      const schema = {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      };
      const ok = structureAssistantText('{"name":"Ada"}', {
        mode: "json_schema",
        strict: true,
        schema,
      });
      expect(ok.ok).toBe(true);
      const bad = structureAssistantText('{"name":1}', {
        mode: "json_schema",
        strict: true,
        schema,
      });
      expect(bad.ok).toBe(false);
    });
  });

  describe("instructions", () => {
    it("appends requirements to prompt", () => {
      const out = appendStructuredOutputInstructions("User: hi", {
        mode: "json_object",
        strict: true,
      });
      expect(out).toContain("User: hi");
      expect(out).toContain("Structured output requirements");
      expect(structuredOutputInstructions({ mode: "json_object", strict: true })).toContain(
        "JSON object",
      );
    });
  });
});
