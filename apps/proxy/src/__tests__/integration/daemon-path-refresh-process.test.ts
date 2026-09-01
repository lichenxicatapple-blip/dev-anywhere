import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const PROCESS_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT_BYTES = 16 * 1024;
const fixtureRoots = new Set<string>();

interface ProcessFixtureResult {
  mode: "auto" | "manual";
  directInvocation: boolean;
  pathSource: "caller" | "login-shell" | "fallback";
  failureReason: string | null;
  helperPathMatchesExpected: boolean;
  helperSentinelPreserved: boolean;
  daemonPathMatchesExpected: boolean;
  daemonSentinelPreserved: boolean;
  lockOwnerMatchesParent: boolean;
  profileIsIsolated: boolean;
  lockPathIsIsolated: boolean;
}

interface ProcessFixture {
  root: string;
  home: string;
  profile: string;
  callerPath: string;
  loginPath: string;
  shellPath: string;
  shellMarkerPath: string;
  lockPath: string;
}

function createProcessFixture(): ProcessFixture {
  const root = mkdtempSync(join(tmpdir(), "dev-anywhere-path-refresh-process-"));
  fixtureRoots.add(root);
  const home = join(root, "home");
  const callerBin = join(root, "caller-bin");
  const loginBin = join(root, "login-bin");
  const callerPath = `${callerBin}:/usr/bin:/bin`;
  const loginPath = `${loginBin}:/usr/bin:/bin`;
  const shellPath = join(root, "fake-login-shell");
  const shellMarkerPath = join(home, ".fixture-login-shell-invoked");
  const profile = `path-refresh-${randomUUID()}`;
  const lockPath = join(home, ".dev-anywhere", "run", "auto-update.lock");

  mkdirSync(home, { recursive: true });
  mkdirSync(callerBin, { recursive: true });
  mkdirSync(loginBin, { recursive: true });
  writeFileSync(join(home, ".fixture-login-path"), `${loginPath}\n`, { mode: 0o600 });
  writeFileSync(
    shellPath,
    [
      "#!/bin/sh",
      'if [ "$#" -ne 4 ] || [ "$1" != "-l" ] || [ "$2" != "-i" ] || [ "$3" != "-c" ]; then',
      "  exit 64",
      "fi",
      'IFS= read -r PATH < "$HOME/.fixture-login-path"',
      "export PATH",
      ': > "$HOME/.fixture-login-shell-invoked"',
      'exec /bin/sh -c "$4"',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  chmodSync(shellPath, 0o700);

  return {
    root,
    home,
    profile,
    callerPath,
    loginPath,
    shellPath,
    shellMarkerPath,
    lockPath,
  };
}

async function runProcessFixture(
  fixture: ProcessFixture,
  mode: "auto" | "manual",
): Promise<ProcessFixtureResult> {
  const parentPath = fileURLToPath(
    new URL("./fixtures/daemon-path-refresh-parent.ts", import.meta.url),
  );
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      parentPath,
      "--profile",
      fixture.profile,
      "--mode",
      mode,
      "--caller-path",
      fixture.callerPath,
      "--login-path",
      fixture.loginPath,
    ],
    {
      cwd: fileURLToPath(new URL("../../../../../", import.meta.url)),
      env: {
        HOME: fixture.home,
        PATH: fixture.callerPath,
        SHELL: fixture.shellPath,
        NODE_ENV: "test",
        VITEST: "1",
        DAEMON_PATH_FIXTURE_SENTINEL: "preserved",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (Buffer.byteLength(stdout) > OUTPUT_LIMIT_BYTES) child.kill("SIGKILL");
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    if (Buffer.byteLength(stderr) > OUTPUT_LIMIT_BYTES) child.kill("SIGKILL");
  });

  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Process-level PATH fixture timed out"));
    }, PROCESS_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });

  if (code !== 0) {
    throw new Error(
      `Process-level PATH fixture exited ${code}: ${stderr.slice(-2_000) || "no diagnostic"}`,
    );
  }
  return JSON.parse(stdout) as ProcessFixtureResult;
}

afterEach(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true });
  fixtureRoots.clear();
});

describe.sequential("daemon PATH refresh process boundary", () => {
  it("uses a fake login-shell PATH for a CLI directly parented by the real updater lock owner", async () => {
    const fixture = createProcessFixture();

    const result = await runProcessFixture(fixture, "auto");

    expect(result).toEqual({
      mode: "auto",
      directInvocation: true,
      pathSource: "login-shell",
      failureReason: null,
      helperPathMatchesExpected: true,
      helperSentinelPreserved: true,
      daemonPathMatchesExpected: true,
      daemonSentinelPreserved: true,
      lockOwnerMatchesParent: true,
      profileIsIsolated: true,
      lockPathIsIsolated: true,
    });
    expect(existsSync(fixture.shellMarkerPath)).toBe(true);
    expect(existsSync(fixture.lockPath)).toBe(false);
  });

  it("keeps the caller PATH and never launches the login shell for a manual invocation", async () => {
    const fixture = createProcessFixture();

    const result = await runProcessFixture(fixture, "manual");

    expect(result).toEqual({
      mode: "manual",
      directInvocation: false,
      pathSource: "caller",
      failureReason: null,
      helperPathMatchesExpected: true,
      helperSentinelPreserved: true,
      daemonPathMatchesExpected: true,
      daemonSentinelPreserved: true,
      lockOwnerMatchesParent: false,
      profileIsIsolated: true,
      lockPathIsIsolated: true,
    });
    expect(existsSync(fixture.shellMarkerPath)).toBe(false);
    expect(existsSync(fixture.lockPath)).toBe(false);
  });
});
