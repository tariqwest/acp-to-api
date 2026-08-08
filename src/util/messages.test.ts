import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import {
  commonExistingParent,
  contentToText,
  extractExistingPaths,
  messagesToPrompt,
  resolveCwd,
} from "./messages.ts";

describe("messages utility", () => {
  describe("contentToText", () => {
    it("handles string content", () => {
      expect(contentToText("hello")).toBe("hello");
    });

    it("handles null/undefined content", () => {
      expect(contentToText(null)).toBe("");
      expect(contentToText(undefined)).toBe("");
    });

    it("handles array of text objects", () => {
      const content = [
        { type: "text", text: "part 1" },
        { type: "text", text: "part 2" },
      ];
      expect(contentToText(content)).toBe("part 1\npart 2");
    });

    it("handles nested content objects", () => {
      const content = { text: "direct text" };
      expect(contentToText(content)).toBe("direct text");
    });

    it("maps image_url parts to placeholders", () => {
      expect(
        contentToText([{ type: "image_url", image_url: { url: "https://x/y.png" } }]),
      ).toBe("[image:https://x/y.png]");
    });
  });

  describe("messagesToPrompt", () => {
    it("formats system, user, and assistant messages", () => {
      const prompt = messagesToPrompt([
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ]);
      expect(prompt).toContain("System instructions:\nYou are helpful.");
      expect(prompt).toContain("User: Hello");
      expect(prompt).toContain("Assistant: Hi there");
    });

    it("appends tool hints when tools are supplied", () => {
      const prompt = messagesToPrompt([{ role: "user", content: "Do work" }], [
        { type: "function", function: { name: "shell_command" } },
      ]);
      expect(prompt).toContain("shell_command");
      expect(prompt).toContain("OpenAI client tools");
    });

    it("includes tool_call_id and assistant tool_calls in prompt", () => {
      const prompt = messagesToPrompt([
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "lookup", arguments: '{"q":"x"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", name: "lookup", content: "result" },
      ]);
      expect(prompt).toContain("tool_call_id=call_1");
      expect(prompt).toContain("name=lookup");
      expect(prompt).toContain("Tool result");
    });
  });

  describe("extractExistingPaths and commonExistingParent", () => {
    it("extracts existing paths from prompt text", () => {
      const paths = extractExistingPaths("Please check /Users or ~/ or nonexistent /fake/path/xyz");
      expect(paths.length).toBeGreaterThan(0);
    });

    it("finds common parent of paths", () => {
      const parent = commonExistingParent(["/Users", "/Users/Shared"]);
      expect(parent).toBe("/Users");
    });
  });

  describe("resolveCwd", () => {
    it("returns explicit cwd if provided and exists", () => {
      const cwd = resolveCwd({
        explicit: process.cwd(),
        fallback: "/tmp",
      });
      expect(cwd).toBe(process.cwd());
    });

    it("expands ~/ in explicit cwd", () => {
      const home = process.env.HOME;
      if (home) {
        const cwd = resolveCwd({
          explicit: "~",
          fallback: "/tmp",
        });
        expect(cwd).toBe(resolve(home));
      }
    });

    it("converts explicit file path to directory", () => {
      const file = resolve(process.cwd(), "package.json");
      const cwd = resolveCwd({
        explicit: file,
        fallback: "/tmp",
      });
      expect(cwd).toBe(process.cwd());
    });

    it("infers cwd from messages if explicit is absent/nonexistent", () => {
      const currentDir = process.cwd();
      const cwd = resolveCwd({
        messages: [{ role: "user", content: `Look at file in ${currentDir}` }],
        fallback: "/tmp",
      });
      expect(cwd).toBe(currentDir);
    });

    it("returns fallback if explicit is absent and no paths in messages", () => {
      const cwd = resolveCwd({
        messages: [{ role: "user", content: "No paths here" }],
        fallback: "/tmp",
      });
      expect(cwd).toBe("/tmp");
    });
  });
});
