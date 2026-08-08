import { describe, expect, it } from "bun:test";
import {
  buildNonStreamChoice,
  buildStreamChoice,
  estimateUsageFromText,
  mapStopReason,
  normalizeUsage,
  shouldIncludeStreamUsage,
  zeroUsage,
} from "./completion-meta.ts";

describe("completion-meta", () => {
  describe("mapStopReason", () => {
    it("maps end_turn and empty to stop", () => {
      expect(mapStopReason("end_turn")).toBe("stop");
      expect(mapStopReason("")).toBe("stop");
      expect(mapStopReason(null)).toBe("stop");
      expect(mapStopReason("cancelled")).toBe("stop");
    });

    it("maps length-like reasons", () => {
      expect(mapStopReason("max_tokens")).toBe("length");
      expect(mapStopReason("max-tokens")).toBe("length");
      expect(mapStopReason("length")).toBe("length");
      expect(mapStopReason("output_limit")).toBe("length");
    });

    it("maps tool and function call reasons", () => {
      expect(mapStopReason("tool_use")).toBe("tool_calls");
      expect(mapStopReason("tool_calls")).toBe("tool_calls");
      expect(mapStopReason("function_call")).toBe("function_call");
    });

    it("maps content filter / safety", () => {
      expect(mapStopReason("content_filter")).toBe("content_filter");
      expect(mapStopReason("safety_blocked")).toBe("content_filter");
      expect(mapStopReason("moderation")).toBe("content_filter");
    });
  });

  describe("usage helpers", () => {
    it("normalizes totals", () => {
      expect(normalizeUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 0 })).toEqual({
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      });
      expect(zeroUsage()).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    });

    it("estimates completion tokens from text when missing", () => {
      const u = estimateUsageFromText(
        { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 },
        "abcd", // 1 token est
      );
      expect(u.completion_tokens).toBe(1);
      expect(u.prompt_tokens).toBe(99);
      expect(u.total_tokens).toBe(100);
    });
  });

  describe("choice builders", () => {
    it("builds non-stream choice with logprobs null", () => {
      const c = buildNonStreamChoice({ content: "hi", finishReason: "stop" });
      expect(c).toEqual({
        index: 0,
        message: { role: "assistant", content: "hi", refusal: null },
        finish_reason: "stop",
        logprobs: null,
      });
    });

    it("builds stream choice deltas", () => {
      expect(buildStreamChoice({ delta: { content: "x" } }).finish_reason).toBeNull();
      expect(buildStreamChoice({ finishReason: "length" }).finish_reason).toBe("length");
    });
  });

  describe("stream_options", () => {
    it("defaults include_usage to true", () => {
      expect(shouldIncludeStreamUsage(undefined)).toBe(true);
      expect(shouldIncludeStreamUsage({})).toBe(true);
      expect(shouldIncludeStreamUsage({ include_usage: false })).toBe(false);
      expect(shouldIncludeStreamUsage({ include_usage: true })).toBe(true);
    });
  });
});
