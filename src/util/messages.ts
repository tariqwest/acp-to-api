import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildToolsPromptSection } from "../openai/tools.ts";

export type ChatMessage = {
  role?: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown;
  function_call?: unknown;
};

export function contentToText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === "string") {
        if (item) parts.push(item);
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const type = String(rec.type ?? "").toLowerCase();
      if (type === "text" || type === "input_text" || type === "output_text") {
        const t = String(rec.text ?? "");
        if (t) parts.push(t);
      } else if (type === "image_url" || type === "image") {
        const url =
          typeof rec.image_url === "string"
            ? rec.image_url
            : rec.image_url && typeof rec.image_url === "object"
              ? String((rec.image_url as Record<string, unknown>).url ?? "")
              : String(rec.url ?? "");
        parts.push(url ? `[image:${url}]` : "[image]");
      } else if (type === "input_image") {
        parts.push("[image]");
      } else if (typeof rec.text === "string") {
        parts.push(rec.text);
      } else if ("content" in rec) {
        const nested = contentToText(rec.content);
        if (nested) parts.push(nested);
      }
    }
    return parts.join("\n");
  }
  if (typeof content === "object") {
    const rec = content as Record<string, unknown>;
    if (typeof rec.text === "string") return rec.text;
    if ("content" in rec) return contentToText(rec.content);
  }
  return String(content);
}

function formatToolCalls(toolCalls: unknown): string {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return "";
  const lines: string[] = ["Assistant tool_calls:"];
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== "object") continue;
    const rec = tc as Record<string, unknown>;
    const id = rec.id != null ? String(rec.id) : "";
    const fn = rec.function && typeof rec.function === "object"
      ? (rec.function as Record<string, unknown>)
      : null;
    const name = fn && typeof fn.name === "string" ? fn.name : "unknown";
    const args = fn?.arguments != null
      ? typeof fn.arguments === "string"
        ? fn.arguments
        : JSON.stringify(fn.arguments)
      : "{}";
    lines.push(`- id=${id || "(none)"} name=${name} arguments=${args}`);
  }
  return lines.join("\n");
}

export type MessagesToPromptOptions = {
  tools?: unknown[];
  toolChoice?: unknown;
  /** When false, omit the default "Important:" workspace instructions. Default true. */
  includeWorkspaceHints?: boolean;
};

/**
 * Flatten chat messages into an ACP prompt while preserving role structure,
 * tool_call_id, and assistant tool_calls better than a bare text join.
 */
export function messagesToPrompt(
  messages: ChatMessage[],
  toolsOrOpts?: unknown[] | MessagesToPromptOptions,
): string {
  const opts: MessagesToPromptOptions = Array.isArray(toolsOrOpts)
    ? { tools: toolsOrOpts }
    : toolsOrOpts ?? {};

  const systemParts: string[] = [];
  const convoParts: string[] = [];

  for (const msg of messages ?? []) {
    const role = String(msg.role ?? "user").toLowerCase();
    const content = contentToText(msg.content).trim();
    const name = msg.name ? ` name=${msg.name}` : "";

    if (role === "system" || role === "developer") {
      if (content) systemParts.push(content);
      continue;
    }

    if (role === "assistant") {
      const chunks: string[] = [];
      if (content) chunks.push(content);
      if (msg.tool_calls) {
        const tc = formatToolCalls(msg.tool_calls);
        if (tc) chunks.push(tc);
      }
      if (msg.function_call && typeof msg.function_call === "object") {
        const fc = msg.function_call as Record<string, unknown>;
        chunks.push(
          `Assistant function_call: name=${String(fc.name ?? "")} arguments=${String(fc.arguments ?? "{}")}`,
        );
      }
      if (chunks.length) convoParts.push(`Assistant${name}: ${chunks.join("\n")}`);
      continue;
    }

    if (role === "tool") {
      const id = msg.tool_call_id ? ` tool_call_id=${msg.tool_call_id}` : "";
      const label = msg.name ? msg.name : "tool";
      convoParts.push(`Tool result (${label}${id}): ${content || "(empty)"}`);
      continue;
    }

    if (role === "function") {
      // legacy function role
      convoParts.push(`Function result (${msg.name ?? "function"}): ${content || "(empty)"}`);
      continue;
    }

    if (content) convoParts.push(`User${name}: ${content}`);
  }

  const toolNote = buildToolsPromptSection(opts.tools, opts.toolChoice);

  const base = systemParts.length
    ? `System instructions:\n${systemParts.join("\n\n")}\n\nConversation:\n${convoParts.join("\n\n")}`
    : convoParts.join("\n\n");

  const workspace =
    opts.includeWorkspaceHints === false
      ? ""
      : "\n\nImportant:" +
        "\n- Do the work directly in the workspace when the user asks to create, edit or run files." +
        "\n- Prefer non-interactive commands." +
        "\n- Do not only describe a plan when you can execute the task.";

  return (base + toolNote + workspace).trim();
}

const PATH_RE = /(?:^|[\s"'`(=])((?:\/|~\/)[^\s"'`<>|]+)/g;

export function extractExistingPaths(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(PATH_RE)) {
    const raw = (match[1] ?? "").replace(/[.,;:!?)\\]]+$/, "");
    if (!raw) continue;
    const expanded = raw.startsWith("~/") ? resolve(process.env.HOME ?? "", raw.slice(2)) : raw;
    try {
      if (existsSync(expanded)) found.push(resolve(expanded));
    } catch {
      // ignore
    }
  }
  return found;
}

export function commonExistingParent(paths: string[]): string | null {
  if (!paths.length) return null;
  const dirs = paths.map((p) => {
    try {
      return statSync(p).isFile() ? dirname(p) : p;
    } catch {
      return dirname(p);
    }
  });
  if (dirs.length === 1) return dirs[0] ?? null;
  const parts = dirs.map((d) => d.split("/").filter(Boolean));
  const minLen = Math.min(...parts.map((p) => p.length));
  const common: string[] = [];
  for (let i = 0; i < minLen; i++) {
    const seg = parts[0]?.[i];
    if (!seg) break;
    let match = true;
    for (let j = 1; j < parts.length; j++) {
      if (parts[j]?.[i] !== seg) {
        match = false;
        break;
      }
    }
    if (!match) break;
    common.push(seg);
  }
  return "/" + common.join("/");
}

export function resolveCwd(opts: {
  explicit?: string | null;
  messages?: ChatMessage[];
  fallback?: string;
}): string {
  if (opts.explicit && typeof opts.explicit === "string") {
    const raw = opts.explicit.trim();
    if (raw) {
      const expanded =
        raw.startsWith("~/") || raw === "~"
          ? resolve(process.env.HOME ?? "", raw.startsWith("~/") ? raw.slice(2) : "")
          : resolve(raw);
      if (existsSync(expanded)) {
        try {
          return statSync(expanded).isFile() ? dirname(expanded) : expanded;
        } catch {
          return expanded;
        }
      }
    }
  }
  const text = messagesToPrompt(opts.messages ?? [], { includeWorkspaceHints: false });
  const paths = extractExistingPaths(text);
  const inferred = commonExistingParent(paths);
  if (inferred) return inferred;
  return opts.fallback ?? process.cwd();
}
