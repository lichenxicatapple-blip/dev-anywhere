import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface SessionHistoryEntry {
  id: string;
  title: string;
  projectDir: string;
  updatedAt: number;
}

// 扫描 ~/.claude/projects/ 目录获取 Claude Code 会话历史
// 目录结构: ~/.claude/projects/<encoded-project-path>/.sessions/<session-files>
export async function scanSessionHistory(): Promise<SessionHistoryEntry[]> {
  const projectsDir = join(homedir(), ".claude", "projects");
  const entries: SessionHistoryEntry[] = [];

  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return [];
  }

  for (const encodedDir of projectDirs) {
    const projectPath = join(projectsDir, encodedDir);
    const sessionsDir = join(projectPath, ".sessions");

    let sessionFiles: string[];
    try {
      sessionFiles = await readdir(sessionsDir);
    } catch {
      continue;
    }

    for (const file of sessionFiles) {
      if (!file.endsWith(".json")) continue;

      const filePath = join(sessionsDir, file);
      try {
        const fileStat = await stat(filePath);
        const content = await readFile(filePath, "utf-8");
        const parsed = JSON.parse(content);

        const sessionId = file.replace(/\.json$/, "");
        const title = parsed.title ?? parsed.name ?? sessionId;
        // encoded dir 用 - 分隔，还原为路径
        const projectDir = decodeProjectDir(encodedDir);

        entries.push({
          id: sessionId,
          title: typeof title === "string" ? title : sessionId,
          projectDir,
          updatedAt: fileStat.mtimeMs,
        });
      } catch {
        continue;
      }
    }
  }

  // 按更新时间倒序排列
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  return entries;
}

// Claude Code projects 目录使用路径分隔符替换为 - 的编码方式
// /Users/admin/workspace/project -> -Users-admin-workspace-project
function decodeProjectDir(encoded: string): string {
  return encoded.replace(/-/g, "/");
}
