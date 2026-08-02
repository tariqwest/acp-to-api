import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppConfig, CatalogModel } from "../types.ts";
import type { Registry } from "../adapters/registry.ts";
import { openAcpSession } from "./client.ts";

const DISCOVER_TIMEOUT_MS = Number(process.env.ACP_TO_API_DISCOVER_TIMEOUT_MS ?? 12_000);
const DISCOVER =
  process.env.ACP_TO_API_DISCOVER_MODELS === undefined
    ? true
    : !["0", "false", "no"].includes(process.env.ACP_TO_API_DISCOVER_MODELS.toLowerCase());
const CACHE_PATH =
  process.env.ACP_TO_API_CATALOG_CACHE ??
  join(process.env.HOME ?? "/tmp", ".cache", "acp-to-api", "models-catalog.json");
const CACHE_TTL_MS = Number(process.env.ACP_TO_API_CATALOG_CACHE_TTL_MS ?? 24 * 60 * 60 * 1000);

interface CacheFile {
  version: 1;
  updatedAt: number;
  models: CatalogModel[];
}

/**
 * Builds OpenAI /v1/models list.
 * Instant baseline from binaries + optional disk cache; discovery runs in background.
 */
export class ModelCatalog {
  private models: CatalogModel[] = [];
  private readonly created = Math.floor(Date.now() / 1000);
  private discovering = false;
  private lastDiscoverAt = 0;

  constructor(
    private readonly registry: Registry,
    private readonly config: AppConfig,
  ) {}

  list(): CatalogModel[] {
    return this.models;
  }

  /** Fast path: binaries + cache, then schedule background discovery. */
  async bootstrap(): Promise<void> {
    const available = await this.registry.detectAvailable();
    const baseline = available.map((agentId) => this.agentDefault(agentId));

    const cached = await this.readCache();
    if (cached?.models?.length) {
      const merged = this.mergeModels(baseline, cached.models);
      this.models = merged;
      console.error(
        `[catalog] loaded ${cached.models.length} cached model(s); baseline agents: ${available.join(", ")}`,
      );
      const age = Date.now() - cached.updatedAt;
      if (DISCOVER && age > CACHE_TTL_MS) {
        void this.refreshInBackground("cache-stale");
      } else if (DISCOVER && age <= CACHE_TTL_MS) {
        // still refresh in background occasionally to pick up new agents
        void this.refreshInBackground("cache-warm");
      }
      return;
    }

    this.models = baseline;
    if (DISCOVER) void this.refreshInBackground("cold");
  }

  /** Blocking full refresh (used by tests / admin). */
  async refresh(): Promise<void> {
    await this.discoverAndSet();
  }

  private refreshInBackground(reason: string) {
    if (this.discovering) return;
    // debounce: at most once per 30s
    if (Date.now() - this.lastDiscoverAt < 30_000 && reason !== "cold") return;
    this.discovering = true;
    this.lastDiscoverAt = Date.now();
    console.error(`[catalog] background discovery starting (${reason})…`);
    this.discoverAndSet()
      .then(() => console.error(`[catalog] background discovery done: ${this.models.length} model(s)`))
      .catch((err) => console.error(`[catalog] background discovery failed: ${String(err)}`))
      .finally(() => {
        this.discovering = false;
      });
  }

  private async discoverAndSet(): Promise<void> {
    const available = await this.registry.detectAvailable();
    const next: CatalogModel[] = available.map((id) => this.agentDefault(id));

    if (DISCOVER) {
      // parallel discovery with per-agent timeout
      await Promise.all(
        available.map(async (agentId) => {
          const spec = this.registry.getSpec(agentId);
          if (!spec) return;
          try {
            const models = await withTimeout(
              discoverAgentModels(spec, this.config.defaultCwd ?? process.cwd()),
              DISCOVER_TIMEOUT_MS,
              `discover ${agentId}`,
            );
            for (const m of models) {
              next.push({
                id: `acp-${agentId}/${m.id}`,
                object: "model",
                created: this.created,
                owned_by: `acp-${agentId}`,
                metadata: { agentId, modelId: m.id, name: m.name },
              });
            }
            console.error(`[catalog] ${agentId}: ${models.length} model option(s)`);
          } catch (err) {
            console.error(`[catalog] ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }),
      );
    }

    this.models = this.dedupeSort(next);
    await this.writeCache(this.models);
  }

  private agentDefault(agentId: string): CatalogModel {
    return {
      id: `acp-${agentId}`,
      object: "model",
      created: this.created,
      owned_by: `acp-${agentId}`,
      metadata: { agentId },
    };
  }

  private mergeModels(baseline: CatalogModel[], cached: CatalogModel[]): CatalogModel[] {
    const available = new Set(baseline.map((m) => m.metadata?.agentId).filter(Boolean));
    const kept = cached.filter((m) => {
      const agentId = m.metadata?.agentId ?? m.owned_by.replace(/^acp-/, "");
      return available.has(agentId);
    });
    return this.dedupeSort([...baseline, ...kept]);
  }

  private dedupeSort(models: CatalogModel[]): CatalogModel[] {
    const map = new Map<string, CatalogModel>();
    for (const m of models) map.set(m.id, m);
    return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  private async readCache(): Promise<CacheFile | null> {
    try {
      const file = Bun.file(CACHE_PATH);
      if (!(await file.exists())) return null;
      const data = (await file.json()) as CacheFile;
      if (!data || data.version !== 1 || !Array.isArray(data.models)) return null;
      return data;
    } catch {
      return null;
    }
  }

  private async writeCache(models: CatalogModel[]): Promise<void> {
    try {
      await mkdir(dirname(CACHE_PATH), { recursive: true });
      const payload: CacheFile = { version: 1, updatedAt: Date.now(), models };
      await Bun.write(CACHE_PATH, JSON.stringify(payload));
    } catch (err) {
      console.error(`[catalog] cache write failed: ${String(err)}`);
    }
  }
}

async function discoverAgentModels(
  spec: { agentId: string; command: string; args: string[]; env: Record<string, string>; bootstrapCommands: string[] },
  cwd: string,
): Promise<Array<{ id: string; name?: string }>> {
  const handle = await openAcpSession({
    spec: {
      agentId: spec.agentId,
      command: spec.command,
      args: spec.args,
      env: spec.env,
      bootstrapCommands: [],
      defaultModel: undefined,
    },
    cwd,
    permissionMode: "deny",
  });
  try {
    return handle.discoveredModels ?? [];
  } finally {
    handle.close();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
