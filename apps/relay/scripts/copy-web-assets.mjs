import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const relayDir = resolve(scriptDir, "..");
const sourceDir = resolve(relayDir, "../web/dist");
const targetDir = resolve(relayDir, "assets/web");

if (!existsSync(resolve(sourceDir, "index.html"))) {
  throw new Error(
    `Web build not found at ${sourceDir}. Run "pnpm --filter @dev-anywhere/web build" first.`,
  );
}

rmSync(targetDir, { recursive: true, force: true });
cpSync(sourceDir, targetDir, {
  recursive: true,
  filter: (source) => !source.endsWith(".tsbuildinfo"),
});

console.log(`Copied Web assets: ${sourceDir} -> ${targetDir}`);
