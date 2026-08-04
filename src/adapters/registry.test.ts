import { describe, expect, test } from "bun:test";
import { Registry } from "./registry.ts";
import { normalizeConfig } from "../config.ts";
import type { AppConfig } from "../types.ts";

describe("Registry with TOML configured agents", () => {
  test("resolves custom agents and aliases defined in configuration", () => {
    const rawConfig = {
      agents: {
        opencode: {
          enabled: true,
          command: "opencode",
          args: ["acp"],
          aliases: ["oc"],
        },
        custom_agent: {
          enabled: true,
          command: "custom-agent-bin",
          args: ["--acp"],
          aliases: ["custom", "ca"],
          default_model: "claude-3-5-sonnet",
          cwd: "/path/to/custom/dir",
        },
      },
    };

    const norm = normalizeConfig(rawConfig);
    const config: AppConfig = {
      host: "*********",
      port: 8787,
      authToken: null,
      defaultCwd: null,
      permissionMode: "auto_allow",
      discoverModels: true,
      discoverTimeoutMs: 12000,
      catalogCache: "/tmp/cache.json",
      catalogCacheTtlMs: 86400000,
      debugUpdates: false,
      pool: { maxGlobal: 8, maxPerAgent: 2, idleTtlMs: 300000 },
      agents: norm.agents ?? {},
    };

    const registry = new Registry(config);

    expect(registry.listAgentIds()).toContain("custom_agent");

    const spec = registry.getSpec("custom_agent");
    expect(spec?.command).toBe("custom-agent-bin");
    expect(spec?.args).toEqual(["--acp"]);
    expect(spec?.defaultModel).toBe("claude-3-5-sonnet");
    expect(spec?.cwd).toBe("/path/to/custom/dir");

    // Resolve by name or alias
    const res1 = registry.resolveModel("acp-custom_agent");
    expect(res1.agentId).toBe("custom_agent");
    expect(res1.modelId).toBe("claude-3-5-sonnet");

    const res2 = registry.resolveModel("acp-ca/gpt-4o");
    expect(res2.agentId).toBe("custom_agent");
    expect(res2.modelId).toBe("gpt-4o");
  });
});
