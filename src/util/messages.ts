import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type ChatMessage = {
  role?: string;
  content?: unknown;
  name?: string;
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

export function messagesToPrompt(messages: ChatMessage[], tools?: unknown[]): string {
  const systemParts: string[] = [];
  const convoParts: string[] = [];

  for (const msg of messages ?? []) {
    const role = String(msg.role ?? "user").toLowerCase();
    const content = contentToText(msg.content).trim();
    if (!content) continue;
    if (role === "system" || role === "developer") systemParts.push(content);
    else if (role === "assistant") convoParts.push(`Assistant: ${content}`);
    else if (role === "tool") convoParts.push(`Tool (${msg.name ?? "tool"}): ${content}`);
    else convoParts.push(`User: ${content}`);
  }

  let toolNote = "";
  if (Array.isArray(tools) && tools.length) {
    const names: string[] = [];
    for (const tool of tools) {
      if (!tool || typeof tool !== "object") continue;
      const t = tool as Record<string, unknown>;
      if (String(t.type ?? "") === "function" && t.function && typeof t.function === "object") {
        const name = (t.function as Record<string, unknown>).name;
        if (typeof name === "string" && name) names.push(name);
      }
    }
    if (names.length) {
      toolNote =
        "\n\nClient tool hints:\n" +
        names.join(", ") +
        "\nAct directly in the workspace when file or shell work is needed.";
    }
  }

  const base = systemParts.length
    ? `System instructions:\n${systemParts.join("\n\n")}\n\nConversation:\n${convoParts.join("\n\n")}`
    : convoParts.join("\n\n");

  return (
    base +
    toolNote +
    "\n\nImportant:" +
    "\n- Do the work directly in the workspace when the user asks to create, edit or run files." +
    "\n- Prefer non-interactive commands." +
    "\n- Do not only describe a plan when you can execute the task."
  ).trim();
}

const PATH_RE = /(?:^|[\s"'`(=])((?:\/|~\/)[^\s"'`<>|]+)/g;

export function extractExistingPaths(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(PATH_RE)) {
    const raw = (match[1] ?? "").replace(/[.,;:!?)\]]+$/, "");
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
    if (!seg || parts.some((p) => p[i] !== seg)) break;
    common.push(seg);
  }
  if (!common.length) return dirs[0] ?? null;
  const candidate = "/" + common.join("/");
  return existsSync(candidate) ? candidate : (dirs[0] ?? null);
}

export function resolveCwd(options: {
  explicit?: string | null;
  messages: ChatMessage[];
  fallback: string;
}): string {
  if (options.explicit?.trim()) {
    const p = resolve(options.explicit.trim().replace(/^~(?=\/)/, process.env.HOME ?? ""));
    if (existsSync(p)) return p;
  }
  const blobs = (options.messages ?? []).map((m) => contentToText(m.content)).filter(Boolean);
  const paths = blobs.flatMap((b) => extractExistingPaths(b));
  return commonExistingParent(paths) ?? options.fallback;
}
