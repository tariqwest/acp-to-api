import { resolve } from "node:path";
import type { AppConfig, PermissionMode } from "./types.ts";

const DEFAULT_CONFIG_PATH = resolve(import.meta.dir, "../config/default.json");

function asPermissionMode(value: unknown): PermissionMode {
  return value === "deny" ? "deny" : "auto_allow";
}

export async function loadConfig(path = process.env.ACP_TO_API_CONFIG ?? DEFAULT_CONFIG_PATH): Promise<AppConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Config not found: ${path}`);
  }
  const raw = (await file.json()) as AppConfig;

  const host = process.env.ACP_TO_API_HOST ?? raw.host ?? "*********";
  const port = Number(process.env.ACP_TO_API_PORT ?? raw.port ?? 8787);
  const authToken =
    process.env.ACP_TO_API_TOKEN === undefined
      ? (raw.authToken ?? null)
      : process.env.ACP_TO_API_TOKEN || null;
  const defaultCwd = process.env.ACP_TO_API_CWD ?? raw.defaultCwd ?? null;
  const permissionMode = asPermissionMode(process.env.ACP_TO_API_PERMISSION_MODE ?? raw.permissionMode);

  return {
    host,
    port,
    authToken,
    defaultCwd,
    permissionMode,
    pool: {
      maxGlobal: Number(process.env.ACP_TO_API_POOL_MAX ?? raw.pool?.maxGlobal ?? 8),
      maxPerAgent: Number(process.env.ACP_TO_API_POOL_MAX_PER_AGENT ?? raw.pool?.maxPerAgent ?? 2),
      idleTtlMs: Number(process.env.ACP_TO_API_POOL_IDLE_TTL_MS ?? raw.pool?.idleTtlMs ?? 300_000),
    },
    agents: raw.agents ?? {},
  };
}
