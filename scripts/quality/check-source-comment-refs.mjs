import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["apps", "packages"];
const EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
const BANNED_REF = /\b(?:D|F)-\d{2,}\b|\bPhase\s+\d+(?:[-.]\d+[a-z]?)?\b/g;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".turbo"]);

function extensionOf(path) {
  const lastDot = path.lastIndexOf(".");
  return lastDot === -1 ? "" : path.slice(lastDot);
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      yield* walk(fullPath);
    } else if (stat.isFile() && EXTENSIONS.has(extensionOf(fullPath))) {
      yield fullPath;
    }
  }
}

const findings = [];

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, "utf-8").split("\n");
    lines.forEach((line, index) => {
      BANNED_REF.lastIndex = 0;
      if (BANNED_REF.test(line)) {
        findings.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }
}

if (findings.length > 0) {
  console.error("Internal planning IDs must not appear in source/test files.");
  console.error("Write self-contained comments and test names instead.\n");
  console.error(findings.join("\n"));
  process.exit(1);
}
