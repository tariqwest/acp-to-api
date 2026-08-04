import { describe, expect, it } from "bun:test";
import { pickPermissionOptionId, sessionUpdateText, sessionUpdateUsage } from "./permissions.ts";

describe("permission utility", () => {
  describe("pickPermissionOptionId across agent catalog variants", () => {
    it("handles standard ACP options (opencode, claude, codex)", () => {
      const options = [
        { optionId: "opt-deny", kind: "deny" },
        { optionId: "opt-always", kind: "allow_always" },
        { optionId: "opt-once", kind: "allow_once" },
      ];
      expect(pickPermissionOptionId(options)).toBe("opt-always");
    });

    it("prefers allow_once when allow_always is absent", () => {
      const options = [
        { optionId: "opt-deny", kind: "deny" },
        { optionId: "opt-once", kind: "allow_once" },
      ];
      expect(pickPermissionOptionId(options)).toBe("opt-once");
    });

    it("handles proceed_always and proceed_once (devin, goose)", () => {
      const options = [
        { optionId: "opt-deny", kind: "reject" },
        { optionId: "opt-proceed", kind: "proceed_once" },
      ];
      expect(pickPermissionOptionId(options)).toBe("opt-proceed");
    });

    it("handles snake_case option_id fields (kiro, cline, cursor)", () => {
      const options = [
        { option_id: "deny_1", kind: "deny" },
        { option_id: "allow_1", kind: "allow_always" },
      ];
      expect(pickPermissionOptionId(options)).toBe("allow_1");
    });

    it("handles id field fallback when optionId/option_id missing", () => {
      const options = [
        { id: "id-deny", kind: "deny" },
        { id: "id-allow", kind: "allow_once" },
      ];
      expect(pickPermissionOptionId(options)).toBe("id-allow");
    });

    it("matches name or label containing allow/yes/approve (aider, amp)", () => {
      const options = [
        { optionId: "opt-1", name: "No, cancel" },
        { optionId: "opt-2", name: "Yes, approve action" },
      ];
      expect(pickPermissionOptionId(options)).toBe("opt-2");
    });

    it("falls back to first option when no explicit allow kind is matched", () => {
      const options = [
        { optionId: "opt-custom-1", kind: "custom_action" },
        { optionId: "opt-custom-2", kind: "other" },
      ];
      expect(pickPermissionOptionId(options)).toBe("opt-custom-1");
    });

    it("returns null for empty or invalid options list", () => {
      expect(pickPermissionOptionId([])).toBeNull();
      expect(pickPermissionOptionId(null as any)).toBeNull();
    });
  });

  describe("sessionUpdateText", () => {
    it("extracts text from agent_message_chunk", () => {
      const update = {
        sessionUpdate: "agent_message_chunk",
        content: { text: "Hello world" },
      };
      expect(sessionUpdateText(update)).toBe("Hello world");
    });

    it("returns empty string for non-message updates", () => {
      const update = { sessionUpdate: "tool_call_start" };
      expect(sessionUpdateText(update)).toBe("");
    });
  });

  describe("sessionUpdateUsage", () => {
    it("parses usage_update into prompt_tokens", () => {
      const update = {
        sessionUpdate: "usage_update",
        used: 1250,
      };
      const usage = sessionUpdateUsage(update);
      expect(usage).toEqual({ prompt_tokens: 1250, completion_tokens: 0, total_tokens: 1250 });
    });
  });
});
