import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { getXdgConfigPath, loadDefaultConfigRaw } from "./config.ts";

export function findExecutable(command: string): string | null {
  if (typeof Bun !== "undefined" && typeof Bun.which === "function") {
    try {
      const found = Bun.which(command);
      if (found) return found;
    } catch {
      // ignore
    }
  }
  if (command.includes("/") || command.includes("\\")) {
    return existsSync(command) ? command : null;
  }
  const pathEnv = process.env.PATH ?? "";
  const dirs = pathEnv.split(process.platform === "win32" ? ";" : ":");
  for (const dir of dirs) {
    if (!dir) continue;
    const fullPath = join(dir, command);
    try {
      if (existsSync(fullPath)) {
        return fullPath;
      }
    } catch {
      // skip
    }
  }
  return null;
}

export function isAgentAvailable(agentId: string, cfg: any): boolean {
  if (!cfg || typeof cfg !== "object") return false;

  const command = String(cfg.command ?? agentId);
  const args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
  const aliases = Array.isArray(cfg.aliases) ? cfg.aliases.map(String) : [];

  if (command === "node") {
    const scriptPath = args[0];
    if (scriptPath && existsSync(scriptPath)) {
      return true;
    }
    if (findExecutable(agentId)) return true;
    for (const alias of aliases) {
      if (findExecutable(alias)) return true;
    }
    return false;
  }

  if (command.includes("/") || command.includes("\\")) {
    return existsSync(command);
  }

  if (findExecutable(command)) return true;
  if (findExecutable(agentId)) return true;
  for (const alias of aliases) {
    if (findExecutable(alias)) return true;
  }

  return false;
}

export function cleanAgentConfig(raw: any): Record<string, any> {
  const result: Record<string, any> = {};
  result.enabled = raw.enabled !== undefined ? Boolean(raw.enabled) : true;
  if (raw.command) result.command = String(raw.command);
  if (Array.isArray(raw.args) && raw.args.length > 0) {
    result.args = raw.args.map(String);
  }
  if (raw.env && typeof raw.env === "object" && Object.keys(raw.env).length > 0) {
    result.env = raw.env;
  }
  if (Array.isArray(raw.aliases) && raw.aliases.length > 0) {
    result.aliases = raw.aliases.map(String);
  }
  if (Array.isArray(raw.bootstrapCommands) && raw.bootstrapCommands.length > 0) {
    result.bootstrap_commands = raw.bootstrapCommands.map(String);
  } else if (Array.isArray(raw.bootstrap_commands) && raw.bootstrap_commands.length > 0) {
    result.bootstrap_commands = raw.bootstrap_commands.map(String);
  }
  const defaultModel = raw.defaultModel ?? raw.default_model;
  if (defaultModel) {
    result.default_model = String(defaultModel);
  }
  if (raw.cwd) {
    result.cwd = String(raw.cwd);
  }
  return result;
}

async function askQuestion(query: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolvePrompt) => {
    rl.question(query, (answer) => {
      rl.close();
      resolvePrompt(answer.trim());
    });
  });
}

export async function runInit(args: string[] = []): Promise<void> {
  let autoYes = false;
  let customConfigPath: string | undefined = undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-y" || arg === "--yes") {
      autoYes = true;
    } else if (arg === "--config" && i + 1 < args.length) {
      customConfigPath = args[++i];
    }
  }

  const targetPath = customConfigPath
    ? resolve(customConfigPath)
    : (process.env.ACP_TO_API_CONFIG ? resolve(process.env.ACP_TO_API_CONFIG) : getXdgConfigPath());

  console.log(`[acp-to-api] Initializing configuration...`);
  console.log(`[acp-to-api] Target config file: ${targetPath}`);

  const defaultRaw = await loadDefaultConfigRaw();
  const builtinAgents = defaultRaw.agents ?? {};

  const detectedAgents: Array<{ id: string; cfg: any }> = [];
  for (const [agentId, agentCfg] of Object.entries(builtinAgents)) {
    if (isAgentAvailable(agentId, agentCfg)) {
      detectedAgents.push({ id: agentId, cfg: agentCfg });
    }
  }

  if (detectedAgents.length === 0) {
    console.log(`[acp-to-api] No built-in ACP clients were detected on your system.`);
    console.log(`[acp-to-api] Supported built-in clients: ${Object.keys(builtinAgents).join(", ")}`);
    return;
  }

  console.log(`\nDetected ${detectedAgents.length} built-in ACP client(s) on your system:`);
  for (const agent of detectedAgents) {
    const cmdStr = agent.cfg.command === "node" && agent.cfg.args?.[0]
      ? `node ${agent.cfg.args[0]}`
      : agent.cfg.command;
    console.log(`  • ${agent.id} (command: ${cmdStr})`);
  }
  console.log("");

  const selectedAgentIds: string[] = [];
  const isInteractive = process.stdin.isTTY && !autoYes;

  if (isInteractive) {
    for (const agent of detectedAgents) {
      const answer = await askQuestion(`Enable agent '${agent.id}' in config.toml? [Y/n] `);
      const normalized = answer.toLowerCase();
      if (normalized === "" || normalized === "y" || normalized === "yes") {
        selectedAgentIds.push(agent.id);
      }
    }
  } else {
    console.log(`[acp-to-api] Enabling all detected agents (non-interactive or --yes mode)...`);
    selectedAgentIds.push(...detectedAgents.map((a) => a.id));
  }

  if (selectedAgentIds.length === 0) {
    console.log(`[acp-to-api] No agents selected. Config file was not modified.`);
    return;
  }

  let existingObj: Record<string, any> = {};
  if (existsSync(targetPath)) {
    try {
      const content = readFileSync(targetPath, "utf-8");
      existingObj = parseToml(content) as Record<string, any>;
    } catch (err) {
      console.warn(`[acp-to-api] Warning: Could not parse existing config at ${targetPath}. A new file will be created.`);
      existingObj = {};
    }
  }

  if (!existingObj.agents || typeof existingObj.agents !== "object") {
    existingObj.agents = {};
  }

  for (const agentId of selectedAgentIds) {
    const rawCfg = builtinAgents[agentId];
    if (rawCfg) {
      existingObj.agents[agentId] = cleanAgentConfig(rawCfg);
    }
  }

  const newToml = stringifyToml(existingObj);
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, newToml, "utf-8");

  console.log(`\n[acp-to-api] Successfully updated ${targetPath}`);
  console.log(`[acp-to-api] Enabled agent(s): ${selectedAgentIds.join(", ")}`);
}
