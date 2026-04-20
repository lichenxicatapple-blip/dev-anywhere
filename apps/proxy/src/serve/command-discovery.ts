import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface CommandEntry {
  name: string;
  description: string;
  argumentHint?: string;
  source: string;
}

const REPL_BUILTINS: CommandEntry[] = [
  { name: "/compact", description: "Compact conversation history", source: "builtin" },
  { name: "/status", description: "Show session status", source: "builtin" },
  { name: "/cost", description: "Show token usage and cost", source: "builtin" },
  { name: "/clear", description: "Clear conversation history", source: "builtin" },
  { name: "/model", description: "Switch AI model", argumentHint: "model name (e.g., Haiku, Sonnet)", source: "builtin" },
  { name: "/help", description: "Show available commands", source: "builtin" },
  { name: "/memory", description: "Edit CLAUDE.md memory", source: "builtin" },
  { name: "/review", description: "Review diff of changes", source: "builtin" },
  { name: "/vim", description: "Enter vim mode", source: "builtin" },
  { name: "/terminal-setup", description: "Configure terminal integration", source: "builtin" },
  { name: "/permissions", description: "View and manage permissions", source: "builtin" },
  { name: "/allowed-tools", description: "View allowed tools", source: "builtin" },
  { name: "/add-dir", description: "Add working directory", argumentHint: "directory path", source: "builtin" },
  { name: "/init", description: "Initialize CLAUDE.md in project", source: "builtin" },
  { name: "/listen", description: "Listen for multi-turn responses", source: "builtin" },
  { name: "/pr-comments", description: "View PR comments", source: "builtin" },
  { name: "/release-notes", description: "Generate release notes", source: "builtin" },
  { name: "/ide", description: "Open IDE integration", source: "builtin" },
];

const COMMAND_BLACKLIST = new Set([
  "/login", "/logout", "/config", "/plugin", "/mcp",
  "/install", "/setup-token", "/doctor", "/update", "/upgrade",
  "/memory", "/vim", "/terminal-setup", "/permissions", "/allowed-tools",
  "/ide", "/listen",
]);

interface DiscoverOptions {
  homeDir?: string;
}

/**
 * 从 SKILL.md 内容中解析 YAML frontmatter 的 name/description/argument-hint
 */
export function parseSkillFrontmatter(content: string): {
  name?: string;
  description?: string;
  argumentHint?: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const yaml = match[1];
  const result: { name?: string; description?: string; argumentHint?: string } = {};

  const nameMatch = yaml.match(/^name:\s*(.+)$/m);
  if (nameMatch) result.name = nameMatch[1].trim();

  const descMatch = yaml.match(/^description:\s*(.+)$/m);
  if (descMatch) result.description = descMatch[1].trim();

  const hintMatch = yaml.match(/^argument-hint:\s*(.+)$/m);
  if (hintMatch) result.argumentHint = hintMatch[1].trim();

  return result;
}

/**
 * 扫描 skills 目录，每个子目录下的 SKILL.md 解析为一条命令
 */
function scanSkillsDir(dirPath: string, source: string): CommandEntry[] {
  let entries: string[];
  try {
    entries = readdirSync(dirPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const commands: CommandEntry[] = [];
  for (const name of entries) {
    const skillPath = join(dirPath, name, "SKILL.md");
    try {
      const content = readFileSync(skillPath, "utf-8");
      const parsed = parseSkillFrontmatter(content);
      commands.push({
        name: `/${parsed.name ?? name}`,
        description: parsed.description ?? "",
        argumentHint: parsed.argumentHint,
        source,
      });
    } catch {
      // SKILL.md 不存在或不可读，跳过
    }
  }
  return commands;
}

/**
 * 扫描 commands 目录，每个 .md 文件名即为命令名
 */
function scanCommandsDir(dirPath: string, source: string): CommandEntry[] {
  let entries: string[];
  try {
    entries = readdirSync(dirPath)
      .filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }

  const commands: CommandEntry[] = [];
  for (const filename of entries) {
    const cmdName = filename.replace(/\.md$/, "");
    try {
      const content = readFileSync(join(dirPath, filename), "utf-8");
      const firstLine = content.split("\n")[0].trim();
      commands.push({
        name: `/${cmdName}`,
        description: firstLine,
        source,
      });
    } catch {
      commands.push({
        name: `/${cmdName}`,
        description: "",
        source,
      });
    }
  }
  return commands;
}

/**
 * 扫描插件目录中的 skills 和 commands 子目录
 */
function scanPluginDirs(homeDir: string): CommandEntry[] {
  const pluginCacheDir = join(homeDir, ".claude", "plugins", "cache");
  let pluginNames: string[];
  try {
    pluginNames = readdirSync(pluginCacheDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const commands: CommandEntry[] = [];
  for (const pluginName of pluginNames) {
    const pluginDir = join(pluginCacheDir, pluginName);
    const skillCmds = scanSkillsDir(join(pluginDir, "skills"), "plugin-skill");
    const cmdCmds = scanCommandsDir(join(pluginDir, "commands"), "plugin-command");
    commands.push(...skillCmds, ...cmdCmds);
  }
  return commands;
}

/**
 * 发现所有可用的斜杠命令，合并多个来源并过滤黑名单
 *
 * 来源优先级: project > user > plugin > builtin
 * 同名命令按优先级高的保留
 */
export async function discoverCommands(
  workDir: string,
  options?: DiscoverOptions,
): Promise<CommandEntry[]> {
  const homeDir = options?.homeDir ?? process.env.HOME ?? "";

  const builtins = REPL_BUILTINS.filter((c) => !COMMAND_BLACKLIST.has(c.name));
  const userSkills = scanSkillsDir(join(homeDir, ".claude", "skills"), "user-skill");
  const projectSkills = scanSkillsDir(join(workDir, ".claude", "skills"), "project-skill");
  const userCommands = scanCommandsDir(join(homeDir, ".claude", "commands"), "user-command");
  const projectCommands = scanCommandsDir(join(workDir, ".claude", "commands"), "project-command");
  const pluginCommands = scanPluginDirs(homeDir);

  // 按优先级从低到高合并，同名命令后者覆盖前者
  const commandMap = new Map<string, CommandEntry>();
  for (const cmd of builtins) commandMap.set(cmd.name, cmd);
  for (const cmd of pluginCommands) commandMap.set(cmd.name, cmd);
  for (const cmd of userSkills) commandMap.set(cmd.name, cmd);
  for (const cmd of userCommands) commandMap.set(cmd.name, cmd);
  for (const cmd of projectSkills) commandMap.set(cmd.name, cmd);
  for (const cmd of projectCommands) commandMap.set(cmd.name, cmd);

  // 再次过滤黑名单，防止外部来源引入黑名单命令
  const result: CommandEntry[] = [];
  for (const cmd of commandMap.values()) {
    if (!COMMAND_BLACKLIST.has(cmd.name)) {
      result.push(cmd);
    }
  }

  return result;
}
