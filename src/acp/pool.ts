import type { AgentSpec, AppConfig, PermissionMode, ResolvedModel } from "../types.ts";
import { openAcpSession, type AcpSessionHandle } from "./client.ts";

interface Pooled {
  handle: AcpSessionHandle;
  busy: boolean;
}

export class SessionPool {
  private readonly items: Pooled[] = [];
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly config: AppConfig) {
    setInterval(() => this.evictIdle(), Math.min(30_000, config.pool.idleTtlMs)).unref?.();
  }

  async acquire(options: {
    spec: AgentSpec;
    cwd: string;
    permissionMode: PermissionMode;
    model: ResolvedModel;
    /** Client affinity key from metadata.session_id / user */
    clientKey?: string;
  }): Promise<{ handle: AcpSessionHandle; reused: boolean }> {
    // Prefer idle same agent+cwd+clientKey (true multi-turn affinity)
    const idle = this.items.find((p) => {
      if (p.busy) return false;
      if (p.handle.agentId !== options.spec.agentId) return false;
      if (p.handle.cwd !== options.cwd) return false;
      if (options.clientKey) return p.handle.clientKey === options.clientKey;
      // without client key, only reuse sessions that also have no key
      return !p.handle.clientKey;
    });

    if (idle) {
      idle.busy = true;
      idle.handle.lastUsedAt = Date.now();
      await idle.handle.applyModel(options.model);
      return { handle: idle.handle, reused: true };
    }

    while (this.shouldWait(options.spec.agentId)) {
      await new Promise<void>((r) => this.waiters.push(r));
    }

    const handle = await openAcpSession({
      spec: options.spec,
      cwd: options.cwd,
      permissionMode: options.permissionMode,
      clientKey: options.clientKey,
      debugUpdates: this.config.debugUpdates,
    });
    await handle.applyModel(options.model);
    this.items.push({ handle, busy: true });
    return { handle, reused: false };
  }

  release(handle: AcpSessionHandle, destroy = false) {
    const idx = this.items.findIndex((p) => p.handle === handle);
    if (idx < 0) {
      handle.close();
      return;
    }
    if (destroy) {
      this.items.splice(idx, 1);
      handle.close();
    } else {
      const item = this.items[idx]!;
      item.busy = false;
      item.handle.lastUsedAt = Date.now();
    }
    const w = this.waiters.shift();
    if (w) w();
  }

  async drain() {
    for (const item of this.items) item.handle.close();
    this.items.length = 0;
  }

  private shouldWait(agentId: string): boolean {
    const { maxGlobal, maxPerAgent } = this.config.pool;
    if (this.items.length >= maxGlobal) {
      return !this.items.some((p) => !p.busy && p.handle.agentId === agentId);
    }
    const per = this.items.filter((p) => p.handle.agentId === agentId).length;
    return per >= maxPerAgent && !this.items.some((p) => !p.busy && p.handle.agentId === agentId);
  }

  private evictIdle() {
    const now = Date.now();
    const ttl = this.config.pool.idleTtlMs;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i]!;
      if (!item.busy && now - item.handle.lastUsedAt > ttl) {
        item.handle.close();
        this.items.splice(i, 1);
      }
    }
  }
}
