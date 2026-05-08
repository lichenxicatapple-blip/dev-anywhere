import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageInfo {
  version?: string;
}

function readRelayVersion(): string {
  const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as PackageInfo;
  return pkg.version ?? "unknown";
}

export const RELAY_VERSION = readRelayVersion();
