import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { StaticPreviewInspection, StaticPreviewSource } from "./types.js";

const MAX_SCAN_ENTRIES = 20_000;
const MAX_HTML_ENTRIES = 1_000;
const MAX_SCAN_DEPTH = 64;

function isHtmlFile(path: string): boolean {
  return /\.html?$/i.test(path);
}

function isHiddenOrDependency(name: string): boolean {
  return name.startsWith(".") || name.toLowerCase() === "node_modules";
}

function containsHiddenOrDependencySegment(path: string): boolean {
  return resolve(path).split(sep).filter(Boolean).some(isHiddenOrDependency);
}

function isWithinRoot(rootPath: string, targetPath: string): boolean {
  const rel = relative(rootPath, targetPath);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function toProtocolPath(path: string): string {
  return path.split(sep).join("/");
}

function validateEntryPath(entryPath: string): string {
  const normalized = entryPath.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("入口网页路径无效");
  }
  return normalized;
}

async function collectHtmlEntries(rootPath: string): Promise<string[]> {
  const result: string[] = [];
  const visitedDirectories = new Set<string>();
  let scannedEntries = 0;

  const visit = async (directory: string, relativeDirectory: string, depth: number) => {
    if (depth > MAX_SCAN_DEPTH) throw new Error("文件夹层级过深，无法创建预览");
    const realDirectory = await realpath(directory);
    if (!isWithinRoot(rootPath, realDirectory) || visitedDirectories.has(realDirectory)) return;
    const canonicalRelativeDirectory = toProtocolPath(relative(rootPath, realDirectory));
    if (canonicalRelativeDirectory.split("/").filter(Boolean).some(isHiddenOrDependency)) {
      return;
    }
    visitedDirectories.add(realDirectory);

    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      scannedEntries += 1;
      if (scannedEntries > MAX_SCAN_ENTRIES) {
        throw new Error("文件夹内容过多，无法创建预览");
      }
      if (isHiddenOrDependency(entry.name)) continue;

      const absolutePath = resolve(directory, entry.name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      let entryIsDirectory = entry.isDirectory();
      let entryIsFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(absolutePath);
        } catch {
          continue;
        }
        if (!isWithinRoot(rootPath, target)) continue;
        const canonicalRelativeTarget = toProtocolPath(relative(rootPath, target));
        if (canonicalRelativeTarget.split("/").filter(Boolean).some(isHiddenOrDependency)) {
          continue;
        }
        const targetStat = await stat(target);
        entryIsDirectory = targetStat.isDirectory();
        entryIsFile = targetStat.isFile();
      }

      if (entryIsDirectory) {
        await visit(absolutePath, relativePath, depth + 1);
      } else if (entryIsFile && isHtmlFile(entry.name)) {
        result.push(toProtocolPath(relativePath));
        if (result.length > MAX_HTML_ENTRIES) {
          throw new Error("文件夹里的 HTML 文件过多，无法创建预览");
        }
      }
    }
  };

  await visit(rootPath, "", 0);
  return result.sort((a, b) => a.localeCompare(b));
}

export async function inspectStaticPreviewPath(path: string): Promise<StaticPreviewInspection> {
  const selectionPath = path.trim();
  if (!selectionPath || !isAbsolute(selectionPath) || selectionPath.includes("\0")) {
    throw new Error("请选择绝对路径下的网页文件或文件夹");
  }
  if (containsHiddenOrDependencySegment(selectionPath)) {
    throw new Error("不能公开隐藏目录、隐藏文件或 node_modules 中的网页");
  }

  const selectionLstat = await lstat(selectionPath);
  if (selectionLstat.isSymbolicLink()) {
    throw new Error("不能直接选择符号链接作为网页预览来源");
  }

  if (selectionLstat.isFile()) {
    if (!isHtmlFile(selectionPath)) throw new Error("请选择 HTML 文件");
    if (isHiddenOrDependency(basename(selectionPath))) {
      throw new Error("不能公开隐藏文件或 node_modules 中的网页");
    }
    const rootPath = await realpath(dirname(selectionPath));
    const filePath = await realpath(selectionPath);
    if (
      containsHiddenOrDependencySegment(rootPath) ||
      containsHiddenOrDependencySegment(filePath)
    ) {
      throw new Error("不能公开隐藏目录、隐藏文件或 node_modules 中的网页");
    }
    if (!isWithinRoot(rootPath, filePath)) throw new Error("网页文件超出公开目录");
    const entryPath = basename(selectionPath);
    return {
      rootPath,
      entryPath,
      htmlEntries: [entryPath],
    };
  }

  if (!selectionLstat.isDirectory()) throw new Error("请选择 HTML 文件或文件夹");
  const rootPath = await realpath(selectionPath);
  if (containsHiddenOrDependencySegment(rootPath)) {
    throw new Error("不能公开隐藏目录、隐藏文件或 node_modules 中的网页");
  }
  const htmlEntries = await collectHtmlEntries(rootPath);
  const entryPath = htmlEntries.includes("index.html")
    ? "index.html"
    : htmlEntries.length === 1
      ? htmlEntries[0]
      : undefined;
  return { rootPath, entryPath, htmlEntries };
}

export async function resolveStaticPreviewSource(
  path: string,
  requestedEntryPath: string,
): Promise<{ source: StaticPreviewSource; name: string }> {
  const inspection = await inspectStaticPreviewPath(path);
  if (inspection.htmlEntries.length === 0) throw new Error("这个文件夹里没有 HTML 文件");

  const entryPath = validateEntryPath(requestedEntryPath);
  if (!inspection.htmlEntries.includes(entryPath)) {
    throw new Error("所选入口网页不在这个文件夹中");
  }

  const selected = await lstat(path);
  return {
    source: { kind: "static", rootPath: inspection.rootPath, entryPath },
    name: selected.isFile() ? basename(path) : basename(inspection.rootPath) || inspection.rootPath,
  };
}
