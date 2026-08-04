import type { AgentConfig, AgentId, AgentSpec, AppConfig, ResolvedModel } from "../types.ts";
import { fileExists, isCommandAvailable } from "../util/runtime.ts";

export class Registry {
  private readonly specs = new Map<AgentId, AgentSpec>();
  private readonly aliases = new Map<string, AgentId>();

  constructor(private readonly config: AppConfig) {
    for (const [agentId, cfg] of Object.entries(config.agents)) {
      if (!cfg?.enabled) continue;
      const spec = toSpec(agentId, cfg);
      this.specs.set(agentId, spec);
      this.aliases.set(agentId.toLowerCase(), agentId);
      for (const alias of cfg.aliases ?? []) {
        this.aliases.set(alias.toLowerCase(), agentId);
      }
    }
  }

  listAgentIds(): AgentId[] {
    return [...this.specs.keys()];
  }

  getSpec(agentId: AgentId): AgentSpec | undefined {
    return this.specs.get(agentId);
  }

  /** Resolve OpenAI model string → agent + optional model/effort */
  resolveModel(model: string): ResolvedModel {
    const raw = String(model ?? "").trim();
    if (!raw) throw new Error("model is required");

    let rest = raw;
    // strip optional provider prefix acp/ or acp-
    if (rest.toLowerCase().startsWith("acp/")) rest = rest.slice(4);
    else if (rest.toLowerCase().startsWith("acp-")) rest = rest.slice(4);

    let effort: string | undefined;
    const at = rest.lastIndexOf("@");
    if (at > 0) {
      effort = rest.slice(at + 1).trim() || undefined;
      rest = rest.slice(0, at);
    }

    // forms: <agent>, <agent>/<model>, <agent>:<model>
    let agentKey = rest;
    let modelId: string | undefined;
    const slash = rest.indexOf("/");
    const colon = rest.indexOf(":");
    const sep = slash >= 0 ? slash : colon >= 0 ? colon : -1;
    if (sep >= 0) {
      agentKey = rest.slice(0, sep);
      modelId = rest.slice(sep + 1).trim() || undefined;
    }

    const agentId = this.aliases.get(agentKey.toLowerCase());
    if (!agentId) {
      // maybe whole thing is an alias or a bare known agent default model string
      const asAlias = this.aliases.get(rest.toLowerCase());
      if (!asAlias) {
        throw new Error(
          `Unknown model "${model}". Use acp-<agent> or acp-<agent>/<model>. Known agents: ${this.listAgentIds().join(", ")}`,
        );
      }
      return this.defaultResolved(asAlias);
    }

    const spec = this.specs.get(agentId)!;
    const id = modelId ? `acp-${agentId}/${modelId}${effort ? `@${effort}` : ""}` : `acp-${agentId}`;
    return {
      id,
      agentId,
      modelId: modelId ?? spec.defaultModel,
      effort,
      ownedBy: `acp-${agentId}`,
      displayName: modelId ? `${agentId}/${modelId}` : agentId,
    };
  }

  defaultResolved(agentId: AgentId): ResolvedModel {
    const spec = this.specs.get(agentId);
    if (!spec) throw new Error(`Unknown agent: ${agentId}`);
    return {
      id: `acp-${agentId}`,
      agentId,
      modelId: spec.defaultModel,
      ownedBy: `acp-${agentId}`,
      displayName: agentId,
    };
  }

  async detectAvailable(): Promise<AgentId[]> {
    const available: AgentId[] = [];
    for (const [id, spec] of this.specs) {
      if (spec.command.includes("/") || spec.command.endsWith(".mjs") || spec.command.endsWith(".js")) {
        // absolute/path command — assume present if file exists
        const path = spec.command === "node" ? (spec.args[0] ?? "") : spec.command;
        try {
          if (path && (await fileExists(path))) available.push(id);
          else if (spec.command === "node") available.push(id);
        } catch {
          // skip
        }
        continue;
      }
      if (await isCommandAvailable(spec.command)) available.push(id);
    }
    return available;
  }
}

function toSpec(agentId: string, cfg: AgentConfig): AgentSpec {
  return {
    agentId,
    command: cfg.command,
    args: [...(cfg.args ?? [])],
    env: { ...(cfg.env ?? {}) },
    ...(cfg.cwd !== undefined ? { cwd: cfg.cwd } : {}),
    bootstrapCommands: [...(cfg.bootstrapCommands ?? [])],
    defaultModel: cfg.defaultModel,
  };
}
