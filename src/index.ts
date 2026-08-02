import { loadConfig } from "./config.ts";
import { Registry } from "./adapters/registry.ts";
import { SessionPool } from "./acp/pool.ts";
import { ModelCatalog } from "./acp/catalog.ts";
import { createApp } from "./server.ts";

async function main() {
  const config = await loadConfig();
  const registry = new Registry(config);
  const pool = new SessionPool(config);
  const catalog = new ModelCatalog(registry, config);

  console.error("[acp-to-api] detecting agents…");
  await catalog.bootstrap();
  const models = catalog.list();
  console.error(
    `[acp-to-api] models ready: ${models.length} (baseline/cache; discovery may continue in background)`,
  );
  console.error(
    `[acp-to-api] agents: ${[...new Set(models.map((m) => m.metadata?.agentId).filter(Boolean))].join(", ") || "(none)"}`,
  );

  const app = createApp({ config, registry, pool, catalog });

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: app.fetch,
  });

  console.error(`[acp-to-api] listening on http://${server.hostname}:${server.port}`);
  console.error(`[acp-to-api] OpenAI base URL: http://${server.hostname}:${server.port}/v1`);

  const shutdown = async () => {
    console.error("[acp-to-api] shutting down…");
    await pool.drain();
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
