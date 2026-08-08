import { describe, expect, it } from "bun:test";
import { buildResponsesObject, responsesInputToMessages } from "./responses.ts";

describe("responses adapter", () => {
  it("maps string input", () => {
    const msgs = responsesInputToMessages({ input: "hi", instructions: "be brief" });
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[1]?.content).toBe("hi");
  });

  it("maps message array input", () => {
    const msgs = responsesInputToMessages({
      input: [{ role: "user", content: "x" }],
    });
    expect(msgs).toEqual([{ role: "user", content: "x" }]);
  });

  it("builds response object", () => {
    const r = buildResponsesObject({
      id: "resp_abc",
      model: "acp-opencode",
      content: "hello",
      finishReason: "stop",
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    expect(r.object).toBe("response");
    expect(r.status).toBe("completed");
    expect(r.usage.total_tokens).toBe(2);
  });

  it("marks requires_action for tool_calls", () => {
    const r = buildResponsesObject({
      id: "resp_x",
      model: "m",
      content: "",
      finishReason: "tool_calls",
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      tool_calls: [
        { id: "c1", type: "function", function: { name: "f", arguments: "{}" } },
      ],
    });
    expect(r.status).toBe("requires_action");
    expect(r.output.some((o: any) => o.type === "function_call")).toBe(true);
  });
});
