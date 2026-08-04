import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, getXdgConfigPath, normalizeConfig } from "./config.ts";

describe("getXdgConfigPath", () => {
  const origXdg = process.env.XDG_CONFIG_HOME;
  const origHome = process.env.HOME;

  afterEach(() => {
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdg;
    process.env.HOME = origHome;
  });

  test("uses XDG_CONFIG_HOME when set", () => {
    process.env.XDG_CONFIG_HOME = "/custom/config/dir";
    expect(getXdgConfigPath()).toBe("/custom/config/dir/acp-to-api/config.toml");
  });

  test("defaults to HOME/.config when XDG_CONFIG_HOME is empty", () => {
    delete process.env.XDG_CONFIG_HOME;
    process.env.HOME = "/Users/testuser";
    expect(getXdgConfigPath()).toBe("/Users/testuser/.config/acp-to-api/config.toml");
  });
});

describe("normalizeConfig", () => {
  test("normalizes snake_case keys from TOML structures", () => {
    const raw = {
      host: "*********",
      port: 9000,
      auth_token: "secret",
      default_cwd: "/tmp",
      permission_mode: "deny",
      discover_models: false,
      discover_timeout_ms: 15000,
      catalog_cache: "/tmp/cache.json",
      catalog_cache_ttl_ms: 3600000,
      debug_updates: true,
      pool: {
        max_global: 16,
        max_per_agent: 4,
        idle_ttl_ms: 60000,
      },
      agents: {
        myagent: {
          enabled: true,
          command: "myagent-cli",
          args: ["acp"],
          aliases: ["ma"],
          bootstrap_commands: ["echo init"],
          default_model: "gpt-4o",
          cwd: "~/projects/myagent",
        },
      },
    };

    const norm = normalizeConfig(raw);
    expect(norm.host).toBe("*********");
    expect(norm.port).toBe(9000);
    expect(norm.authToken).toBe("secret");
    expect(norm.defaultCwd).toBe("/tmp");
    expect(norm.permissionMode).toBe("deny");
    expect(norm.discoverModels).toBe(false);
    expect(norm.discoverTimeoutMs).toBe(15000);
    expect(norm.catalogCache).toBe("/tmp/cache.json");
    expect(norm.catalogCacheTtlMs).toBe(3600000);
    expect(norm.debugUpdates).toBe(true);
    expect(norm.pool).toEqual({
      maxGlobal: 16,
      maxPerAgent: 4,
      idleTtlMs: 60000,
    });
    expect(norm.agents?.myagent).toEqual({
      enabled: true,
      command: "myagent-cli",
      args: ["acp"],
      env: {},
      aliases: ["ma"],
      bootstrapCommands: ["echo init"],
      defaultModel: "gpt-4o",
      cwd: join(process.env.HOME ?? "/tmp", "projects/myagent"),
    });
  });
});

describe("loadConfig with TOML", () => {
  const testDir = join(tmpdir(), `acp-to-api-test-${Date.now()}`);

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("loads configuration from a custom TOML file", async () => {
    const tomlPath = join(testDir, "custom.toml");
    const tomlContent = `
port = 9876
permission_mode = "deny"

[agents.testagent]
enabled = true
command = "test-agent-bin"
args = ["--stdio"]
aliases = ["ta"]
default_model = "test-model-1"
`;
    await writeFile(tomlPath, tomlContent, "utf-8");

    const config = await loadConfig(tomlPath);
    expect(config.port).toBe(9876);
    expect(config.permissionMode).toBe("deny");
    expect(config.agents.testagent).toBeDefined();
    expect(config.agents.testagent?.command).toBe("test-agent-bin");
    expect(config.agents.testagent?.aliases).toEqual(["ta"]);
    expect(config.agents.testagent?.defaultModel).toBe("test-model-1");
  });

  test("loads discovery, catalog, and debug options from TOML and allows env overrides", async () => {
    const tomlPath = join(testDir, "env-options.toml");
    const tomlContent = `
discover_models = false
discover_timeout_ms = 5000
catalog_cache = "/tmp/toml-cache.json"
catalog_cache_ttl_ms = 7200000
debug_updates = true
`;
    await writeFile(tomlPath, tomlContent, "utf-8");

    const loadedFromToml = await loadConfig(tomlPath);
    expect(loadedFromToml.discoverModels).toBe(false);
    expect(loadedFromToml.discoverTimeoutMs).toBe(5000);
    expect(loadedFromToml.catalogCache).toBe("/tmp/toml-cache.json");
    expect(loadedFromToml.catalogCacheTtlMs).toBe(7200000);
    expect(loadedFromToml.debugUpdates).toBe(true);

    process.env.ACP_TO_API_DISCOVER_MODELS = "true";
    process.env.ACP_TO_API_DISCOVER_TIMEOUT_MS = "20000";
    process.env.ACP_TO_API_CATALOG_CACHE = "/tmp/env-cache.json";
    process.env.ACP_TO_API_DEBUG_UPDATES = "false";

    try {
      const loadedWithEnv = await loadConfig(tomlPath);
      expect(loadedWithEnv.discoverModels).toBe(true);
      expect(loadedWithEnv.discoverTimeoutMs).toBe(20000);
      expect(loadedWithEnv.catalogCache).toBe("/tmp/env-cache.json");
      expect(loadedWithEnv.debugUpdates).toBe(false);
    } finally {
      delete process.env.ACP_TO_API_DISCOVER_MODELS;
      delete process.env.ACP_TO_API_DISCOVER_TIMEOUT_MS;
      delete process.env.ACP_TO_API_CATALOG_CACHE;
      delete process.env.ACP_TO_API_DEBUG_UPDATES;
    }
  });

  test("loads configuration from XDG_CONFIG_HOME config.toml when no path specified", async () => {
    const origXdg = process.env.XDG_CONFIG_HOME;
    const origAcpConfig = process.env.ACP_TO_API_CONFIG;
    delete process.env.ACP_TO_API_CONFIG;

    try {
      const xdgDir = join(testDir, "xdg-config");
      const appConfigDir = join(xdgDir, "acp-to-api");
      await mkdir(appConfigDir, { recursive: true });
      process.env.XDG_CONFIG_HOME = xdgDir;

      const tomlContent = `
port = 7777

[agents.xdgagent]
enabled = true
command = "xdg-agent-bin"
args = ["--acp"]
`;
      await writeFile(join(appConfigDir, "config.toml"), tomlContent, "utf-8");

      const config = await loadConfig();
      expect(config.port).toBe(7777);
      expect(config.agents.xdgagent).toBeDefined();
      expect(config.agents.xdgagent?.command).toBe("xdg-agent-bin");
      // Default agents should also be merged
      expect(config.agents.opencode).toBeDefined();
    } finally {
      if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = origXdg;
      if (origAcpConfig === undefined) delete process.env.ACP_TO_API_CONFIG;
      else process.env.ACP_TO_API_CONFIG = origAcpConfig;
    }
  });
});
