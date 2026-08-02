#!/usr/bin/env node
/**
 * Package bin entry for acp-to-api.
 *
 * - Under Bun: load TypeScript directly.
 * - Under Node: spawn Node with tsx.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "../src/index.ts");
const isBun = typeof globalThis.Bun !== "undefined";

if (isBun) {
  await import(pathToFileURL(entry).href);
} else {
  let tsxImport;
  try {
    tsxImport = require.resolve("tsx/esm");
  } catch {
    console.error(
      "[acp-to-api] Node runtime requires the `tsx` package. Install deps or run with Bun.",
    );
    process.exit(1);
  }
  const child = spawn(
    process.execPath,
    ["--import", tsxImport, entry, ...process.argv.slice(2)],
    { stdio: "inherit", env: process.env },
  );
  child.on("error", (err) => {
    console.error("[acp-to-api] failed to start:", err);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}
