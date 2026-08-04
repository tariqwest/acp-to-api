import { resolve, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { AgentConfig, AppConfig, PermissionMode, PoolConfig } from "./types.ts";

const DEFAULT_CONFIG_PATH = resolve(import.meta.dir, "../config/default.json");

export function getXdgConfigPath(): string {
  const xdgHome = process.env.XDG_CONFIG_HOME;
  const base = xdgHome && xdgHome.trim() !== "" ? xdgHome : join(process.env.HOME ?? "~", ".config");
  return join(base, "acp-to-api", "config.toml");
}

function asPermissionMode(value: unknown): PermissionMode {
  return value === "deny" ? "deny" : "auto_allow";
}

function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  const str = String(value).toLowerCase().trim();
  if (["0", "false", "no", "off"].includes(str)) return false;
  if (["1", "true", "yes", "on"].includes(str)) return true;
  return undefined;
}

function expandHome(p: string): string {
  if (p === "~") {
    return process.env.HOME ?? "/tmp";
  }
  if (p.startsWith("~/")) {
    return join(process.env.HOME ?? "/tmp", p.slice(2));
  }
  return p;
}

function parseConfigFile(content: string, filePath: string): any {
  if (filePath.endsWith(".json")) {
    return JSON.parse(content);
  }
  if (filePath.endsWith(".toml")) {
    return parseToml(content);
  }
  try {
    return JSON.parse(content);
  } catch {
    return parseToml(content);
  }
}

export function normalizeConfig(raw: any): Partial<AppConfig> {
  if (!raw || typeof raw !== "object") return {};

  const host = raw.host !== undefined ? String(raw.host) : undefined;
  const port = raw.port !== undefined && raw.port !== null ? Number(raw.port) : undefined;
  const authToken =
    raw.authToken !== undefined
      ? raw.authToken
      : raw.auth_token !== undefined
        ? raw.auth_token
        : undefined;
  const rawDefaultCwd = raw.defaultCwd ?? raw.default_cwd;
  const defaultCwd =
    rawDefaultCwd !== undefined && rawDefaultCwd !== null
      ? expandHome(String(rawDefaultCwd))
      : undefined;

  let permissionMode: PermissionMode | undefined = undefined;
  const rawPerm = raw.permissionMode ?? raw.permission_mode;
  if (rawPerm !== undefined) {
    permissionMode = asPermissionMode(rawPerm);
  }

  const discoverModels = parseBoolean(raw.discoverModels ?? raw.discover_models);
  const discoverTimeoutMs =
    raw.discoverTimeoutMs !== undefined && raw.discoverTimeoutMs !== null
      ? Number(raw.discoverTimeoutMs)
      : raw.discover_timeout_ms !== undefined && raw.discover_timeout_ms !== null
        ? Number(raw.discover_timeout_ms)
        : undefined;

  const rawCatalogCache = raw.catalogCache ?? raw.catalog_cache;
  const catalogCache =
    rawCatalogCache !== undefined && rawCatalogCache !== null
      ? expandHome(String(rawCatalogCache))
      : undefined;

  const catalogCacheTtlMs =
    raw.catalogCacheTtlMs !== undefined && raw.catalogCacheTtlMs !== null
      ? Number(raw.catalogCacheTtlMs)
      : raw.catalog_cache_ttl_ms !== undefined && raw.catalog_cache_ttl_ms !== null
        ? Number(raw.catalog_cache_ttl_ms)
        : undefined;

  const debugUpdates = parseBoolean(raw.debugUpdates ?? raw.debug_updates);

  let pool: Partial<PoolConfig> | undefined = undefined;
  const rawPool = raw.pool;
  if (rawPool && typeof rawPool === "object") {
    pool = {
      ...(rawPool.maxGlobal !== undefined
        ? { maxGlobal: Number(rawPool.maxGlobal) }
        : rawPool.max_global !== undefined
          ? { maxGlobal: Number(rawPool.max_global) }
          : {}),
      ...(rawPool.maxPerAgent !== undefined
        ? { maxPerAgent: Number(rawPool.maxPerAgent) }
        : rawPool.max_per_agent !== undefined
          ? { maxPerAgent: Number(rawPool.max_per_agent) }
          : {}),
      ...(rawPool.idleTtlMs !== undefined
        ? { idleTtlMs: Number(rawPool.idleTtlMs) }
        : rawPool.idle_ttl_ms !== undefined
          ? { idleTtlMs: Number(rawPool.idle_ttl_ms) }
          : {}),
    };
  }

  let agents: Record<string, AgentConfig> | undefined = undefined;
  const rawAgents = raw.agents;
  if (rawAgents && typeof rawAgents === "object") {
    agents = {};
    for (const [agentId, agentRaw] of Object.entries(rawAgents)) {
      if (!agentRaw || typeof agentRaw !== "object") continue;
      const a = agentRaw as Record<string, any>;
      const enabled = a.enabled !== undefined ? Boolean(a.enabled) : true;
      const command = String(a.command ?? agentId);
      const args = Array.isArray(a.args) ? a.args.map(String) : [];
      const env =
        a.env && typeof a.env === "object"
          ? Object.fromEntries(Object.entries(a.env).map(([k, v]) => [k, String(v)]))
          : {};
      const aliases = Array.isArray(a.aliases) ? a.aliases.map(String) : [];
      const bootstrapCommands = Array.isArray(a.bootstrapCommands)
        ? a.bootstrapCommands.map(String)
        : Array.isArray(a.bootstrap_commands)
          ? a.bootstrap_commands.map(String)
          : [];
      const defaultModel =
        a.defaultModel !== undefined
          ? String(a.defaultModel)
          : a.default_model !== undefined
            ? String(a.default_model)
            : undefined;
      const cwd =
        a.cwd !== undefined && a.cwd !== null
          ? expandHome(String(a.cwd))
          : undefined;

      agents[agentId] = {
        enabled,
        command,
        args,
        env,
        aliases,
        bootstrapCommands,
        ...(defaultModel !== undefined ? { defaultModel } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
      };
    }
  }

  return {
    ...(host !== undefined && { host }),
    ...(port !== undefined && { port }),
    ...(authToken !== undefined && { authToken: authToken ?? null }),
    ...(defaultCwd !== undefined && { defaultCwd: defaultCwd ?? null }),
    ...(permissionMode !== undefined && { permissionMode }),
    ...(discoverModels !== undefined && { discoverModels }),
    ...(discoverTimeoutMs !== undefined && { discoverTimeoutMs }),
    ...(catalogCache !== undefined && { catalogCache }),
    ...(catalogCacheTtlMs !== undefined && { catalogCacheTtlMs }),
    ...(debugUpdates !== undefined && { debugUpdates }),
    ...(pool !== undefined && { pool: pool as PoolConfig }),
    ...(agents !== undefined && { agents }),
  };
}

export async function loadDefaultConfigRaw(): Promise<any> {
  const baseFile = Bun.file(DEFAULT_CONFIG_PATH);
  if (await baseFile.exists()) {
    const baseText = await baseFile.text();
    return parseConfigFile(baseText, DEFAULT_CONFIG_PATH);
  }
  return {};
}

export async function loadConfig(specifiedPath?: string): Promise<AppConfig> {
  const baseRaw = await loadDefaultConfigRaw();
  const baseNormalized = normalizeConfig(baseRaw);

  let userPath = specifiedPath ?? process.env.ACP_TO_API_CONFIG;

  if (!userPath) {
    const xdgPath = getXdgConfigPath();
    const xdgFile = Bun.file(xdgPath);
    if (await xdgFile.exists()) {
      userPath = xdgPath;
    }
  }

  let userNormalized: Partial<AppConfig> = {};
  if (userPath && userPath !== DEFAULT_CONFIG_PATH) {
    const file = Bun.file(userPath);
    if (!(await file.exists())) {
      throw new Error(`Config not found: ${userPath}`);
    }
    const text = await file.text();
    const userRaw = parseConfigFile(text, userPath);
    userNormalized = normalizeConfig(userRaw);
  }

  const mergedHost = userNormalized.host ?? baseNormalized.host ?? "*********";
  const mergedPort = userNormalized.port ?? baseNormalized.port ?? 8787;
  const mergedAuthToken =
    userNormalized.authToken !== undefined ? userNormalized.authToken : (baseNormalized.authToken ?? null);
  const mergedDefaultCwd =
    userNormalized.defaultCwd !== undefined ? userNormalized.defaultCwd : (baseNormalized.defaultCwd ?? null);
  const mergedPermissionMode = userNormalized.permissionMode ?? baseNormalized.permissionMode ?? "auto_allow";

  const defaultCachePath = join(process.env.HOME ?? "/tmp", ".cache", "acp-to-api", "models-catalog.json");
  const mergedDiscoverModels = userNormalized.discoverModels ?? baseNormalized.discoverModels ?? true;
  const mergedDiscoverTimeoutMs = userNormalized.discoverTimeoutMs ?? baseNormalized.discoverTimeoutMs ?? 12_000;
  const mergedCatalogCache = userNormalized.catalogCache ?? baseNormalized.catalogCache ?? defaultCachePath;
  const mergedCatalogCacheTtlMs = userNormalized.catalogCacheTtlMs ?? baseNormalized.catalogCacheTtlMs ?? 24 * 60 * 60 * 1000;
  const mergedDebugUpdates = userNormalized.debugUpdates ?? baseNormalized.debugUpdates ?? false;

  const mergedPool: PoolConfig = {
    maxGlobal: userNormalized.pool?.maxGlobal ?? baseNormalized.pool?.maxGlobal ?? 8,
    maxPerAgent: userNormalized.pool?.maxPerAgent ?? baseNormalized.pool?.maxPerAgent ?? 2,
    idleTtlMs: userNormalized.pool?.idleTtlMs ?? baseNormalized.pool?.idleTtlMs ?? 300_000,
  };

  const mergedAgents: Record<string, AgentConfig> = { ...baseNormalized.agents };
  if (userNormalized.agents) {
    for (const [agentId, userAgentCfg] of Object.entries(userNormalized.agents)) {
      if (mergedAgents[agentId]) {
        mergedAgents[agentId] = {
          ...mergedAgents[agentId],
          ...userAgentCfg,
        };
      } else {
        mergedAgents[agentId] = userAgentCfg;
      }
    }
  }

  const host = process.env.ACP_TO_API_HOST ?? mergedHost;
  const port = Number(process.env.ACP_TO_API_PORT ?? mergedPort);
  const authToken =
    process.env.ACP_TO_API_TOKEN === undefined
      ? mergedAuthToken
      : process.env.ACP_TO_API_TOKEN || null;
  const defaultCwd = process.env.ACP_TO_API_CWD ?? mergedDefaultCwd;
  const permissionMode = asPermissionMode(
    process.env.ACP_TO_API_PERMISSION_MODE ?? mergedPermissionMode,
  );

  const discoverModels =
    process.env.ACP_TO_API_DISCOVER_MODELS === undefined
      ? mergedDiscoverModels
      : !["0", "false", "no"].includes(process.env.ACP_TO_API_DISCOVER_MODELS.toLowerCase());

  const discoverTimeoutMs =
    process.env.ACP_TO_API_DISCOVER_TIMEOUT_MS === undefined
      ? mergedDiscoverTimeoutMs
      : Number(process.env.ACP_TO_API_DISCOVER_TIMEOUT_MS);

  const catalogCache =
    process.env.ACP_TO_API_CATALOG_CACHE
      ? expandHome(process.env.ACP_TO_API_CATALOG_CACHE)
      : mergedCatalogCache;

  const catalogCacheTtlMs =
    process.env.ACP_TO_API_CATALOG_CACHE_TTL_MS === undefined
      ? mergedCatalogCacheTtlMs
      : Number(process.env.ACP_TO_API_CATALOG_CACHE_TTL_MS);

  const debugUpdates =
    process.env.ACP_TO_API_DEBUG_UPDATES === undefined
      ? mergedDebugUpdates
      : ["1", "true", "yes"].includes(process.env.ACP_TO_API_DEBUG_UPDATES.toLowerCase());

  return {
    host,
    port,
    authToken,
    defaultCwd,
    permissionMode,
    discoverModels,
    discoverTimeoutMs,
    catalogCache,
    catalogCacheTtlMs,
    debugUpdates,
    pool: {
      maxGlobal: Number(process.env.ACP_TO_API_POOL_MAX ?? mergedPool.maxGlobal),
      maxPerAgent: Number(process.env.ACP_TO_API_POOL_MAX_PER_AGENT ?? mergedPool.maxPerAgent),
      idleTtlMs: Number(process.env.ACP_TO_API_POOL_IDLE_TTL_MS ?? mergedPool.idleTtlMs),
    },
    agents: mergedAgents,
  };
}
