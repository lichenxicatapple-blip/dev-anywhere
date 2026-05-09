import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { describe, expect, it } from "vitest";

const RELAY_ENTRY = pathResolve(import.meta.dirname, "../..", "index.ts");
const PACKAGE_JSON = pathResolve(import.meta.dirname, "../../..", "package.json");

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runRelayCli(args: string[], timeoutMs = 5000): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", RELAY_ENTRY, ...args], {
      env: { ...process.env, DATA_DIR: "", LOG_LEVEL: "silent" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      if (settled) return;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

describe("dev-anywhere-relay CLI", () => {
  it("--help prints usage and exits without starting the relay", async () => {
    const result = await runRelayCli(["--help"]);

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("RELAY_PROXY_TOKEN");
    expect(result.stderr).toBe("");
  });

  it("--version prints the package version and exits", async () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf-8")) as { version: string };
    const result = await runRelayCli(["--version"]);

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
    expect(result.stderr).toBe("");
  });
});
