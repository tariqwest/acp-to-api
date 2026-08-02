export type PermissionMode = "auto_allow" | "deny";

export type AgentId = string;

export interface PoolConfig {
  maxGlobal: number;
  maxPerAgent: number;
  idleTtlMs: number;
}

export interface AgentConfig {
  enabled: boolean;
  command: string;
  args: string[];
  env?: Record<string, string>;
  aliases?: string[];
  bootstrapCommands?: string[];
  defaultModel?: string;
}

export interface AppConfig {
  host: string;
  port: number;
  authToken: string | null;
  defaultCwd: string | null;
  permissionMode: PermissionMode;
  pool: PoolConfig;
  agents: Record<AgentId, AgentConfig>;
}

export interface AgentSpec {
  agentId: AgentId;
  command: string;
  args: string[];
  env: Record<string, string>;
  bootstrapCommands: string[];
  defaultModel?: string;
}

export interface ResolvedModel {
  /** OpenAI model id, e.g. acp-opencode/claude-sonnet-4 */
  id: string;
  agentId: AgentId;
  /** Upstream agent model id, or undefined for agent default */
  modelId?: string;
  effort?: string;
  modeId?: string;
  ownedBy: string;
  displayName: string;
}

export interface CatalogModel {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  /** Non-standard extras for clients that care */
  metadata?: {
    agentId: string;
    modelId?: string;
    effort?: string;
    name?: string;
  };
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface StreamTextEvent {
  kind: "text";
  text: string;
}

export interface StreamToolEvent {
  kind: "tool";
  tool: {
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: string;
    rawInput?: unknown;
    content?: unknown;
  };
}

export interface StreamDoneEvent {
  kind: "done";
  stopReason: string;
  usage?: TokenUsage;
}

export type StreamEvent = StreamTextEvent | StreamToolEvent | StreamDoneEvent;
