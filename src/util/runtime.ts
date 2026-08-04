import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { Hono } from "hono";

const execFileAsync = promisify(execFile);

export async function fileExists(filePath: string): Promise<boolean> {
  if (typeof globalThis.Bun !== "undefined") {
    return Bun.file(filePath).exists();
  }
  return existsSync(filePath);
}

export async function fileReadText(filePath: string): Promise<string> {
  if (typeof globalThis.Bun !== "undefined") {
    return Bun.file(filePath).text();
  }
  return readFile(filePath, "utf-8");
}

export async function fileWriteText(filePath: string, content: string): Promise<void> {
  if (typeof globalThis.Bun !== "undefined") {
    await Bun.write(filePath, content);
    return;
  }
  await writeFile(filePath, content, "utf-8");
}

export async function isCommandAvailable(command: string): Promise<boolean> {
  if (typeof globalThis.Bun !== "undefined") {
    try {
      const { $ } = await import("bun");
      const res = await $`which ${command}`.nothrow().quiet();
      return res.exitCode === 0;
    } catch {
      // Fallback if bun $ is unavailable
    }
  }
  try {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    await execFileAsync(whichCmd, [command]);
    return true;
  } catch {
    return false;
  }
}

export interface ServerInstance {
  hostname: string;
  port: number;
  stop: (force?: boolean) => void | Promise<void>;
}

export async function startServer(
  app: Hono,
  options: { host: string; port: number },
  onListen?: (info: { host: string; port: number }) => void,
): Promise<ServerInstance> {
  const isBun = typeof globalThis.Bun !== "undefined";
  if (isBun) {
    const server = Bun.serve({
      hostname: options.host,
      port: options.port,
      fetch: app.fetch,
    });
    const host = server.hostname ?? options.host;
    const port = server.port ?? options.port;
    onListen?.({ host, port });
    return {
      hostname: host,
      port,
      stop: (force?: boolean) => server.stop(force),
    };
  }
  const { serve } = await import("@hono/node-server");
  const server = serve(
    {
      fetch: app.fetch,
      hostname: options.host,
      port: options.port,
    },
    (info) => {
      onListen?.({ host: info.address, port: info.port });
    },
  );
  return {
    hostname: options.host,
    port: options.port,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
