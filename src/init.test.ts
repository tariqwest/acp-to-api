import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseToml } from "smol-toml";
import { isAgentAvailable, cleanAgentConfig, runInit } from "./init.ts";

describe("init module", () => {
  test("cleanAgentConfig formats snake_case fields correctly", () => {
    const raw = {
      enabled: true,
      command: "opencode",
      args: ["acp"],
      aliases: ["oc"],
      env: {},
      bootstrapCommands: ["echo hello"],
      defaultModel: "claude-3-5-sonnet",
      cwd: "/tmp/project",
    };

    const cleaned = cleanAgentConfig(raw);
    expect(cleaned).toEqual({
      enabled: true,
      command: "opencode",
      args: ["acp"],
      aliases: ["oc"],
      bootstrap_commands: ["echo hello"],
      default_model: "claude-3-5-sonnet",
      cwd: "/tmp/project",
    });
  });

  test("isAgentAvailable detects built-in commands", () => {
    expect(isAgentAvailable("opencode", { command: "opencode" })).toBe(true);
    expect(isAgentAvailable("nonexistent_binary_xyz_123", { command: "nonexistent_binary_xyz_123" })).toBe(false);
  });

  describe("runInit execution", () => {
    const testDir = join(tmpdir(), `acp-to-api-init-test-${Date.now()}`);
    const testConfigPath = join(testDir, "config.toml");

    beforeEach(async () => {
      await mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true });
    });

    test("runInit creates config.toml with detected agents when --yes is passed", async () => {
      await runInit(["--yes", "--config", testConfigPath]);

      const content = await readFile(testConfigPath, "utf-8");
      const parsed = parseToml(content) as Record<string, any>;

      expect(parsed.agents).toBeDefined();
      expect(typeof parsed.agents).toBe("object");
      expect(Object.keys(parsed.agents).length).toBeGreaterThan(0);
      expect(parsed.agents.opencode).toBeDefined();
      expect(parsed.agents.opencode.command).toBe("opencode");
    });
  });
});
