import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const relayDir = resolve(scriptDir, "..");
const webSourceDir = resolve(relayDir, "../web/dist");
const webTargetDir = resolve(relayDir, "assets/web");
const fontSourceDir = resolve(relayDir, "../proxy/assets/fonts");
const fontTargetDir = resolve(relayDir, "assets/fonts");

if (!existsSync(resolve(webSourceDir, "index.html"))) {
  throw new Error(
    `Web build not found at ${webSourceDir}. Run "pnpm --filter @dev-anywhere/web build" first.`,
  );
}
if (!existsSync(resolve(fontSourceDir, "sarasa-fixed-sc/result.css"))) {
  throw new Error(`Font assets not found at ${fontSourceDir}.`);
}

rmSync(webTargetDir, { recursive: true, force: true });
cpSync(webSourceDir, webTargetDir, {
  recursive: true,
  filter: (source) => !source.endsWith(".tsbuildinfo"),
});
rmSync(fontTargetDir, { recursive: true, force: true });
cpSync(fontSourceDir, fontTargetDir, { recursive: true });

console.log(`Copied Web assets: ${webSourceDir} -> ${webTargetDir}`);
console.log(`Copied font assets: ${fontSourceDir} -> ${fontTargetDir}`);
