import { describe, expect, it } from "bun:test";
import {
  acpToolsToOpenAIToolCalls,
  buildToolsPromptSection,
  extractEmbeddedToolCalls,
  formatToolChoice,
  parseClientTools,
} from "./tools.ts";

describe("tools bridge", () => {
  it("parses client tools", () => {
    const specs = parseClientTools([
      { type: "function", function: { name: "get_weather", parameters: { type: "object" } } },
    ]);
    expect(specs[0]?.name).toBe("get_weather");
  });

  it("formats tool_choice", () => {
    expect(formatToolChoice("none")).toContain("Do not call tools");
    expect(formatToolChoice({ type: "function", function: { name: "x" } })).toContain('"x"');
  });

  it("builds tools prompt section", () => {
    const s = buildToolsPromptSection(
      [{ type: "function", function: { name: "fn", description: "d" } }],
      "auto",
    );
    expect(s).toContain("fn");
    expect(s).toContain("tool_choice");
  });

  it("maps ACP tools to OpenAI tool_calls", () => {
    const calls = acpToolsToOpenAIToolCalls([
      { toolCallId: "t1", title: "read_file", rawInput: { path: "a.ts" } },
    ]);
    expect(calls[0]).toEqual({
      id: "t1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"a.ts"}' },
    });
  });

  it("extracts embedded tool_calls JSON", () => {
    const { text, tool_calls } = extractEmbeddedToolCalls(
      '{"tool_calls":[{"id":"c1","type":"function","function":{"name":"fn","arguments":"{}"}}]}',
    );
    expect(tool_calls[0]?.function.name).toBe("fn");
    expect(text).toBe("");
  });
});
