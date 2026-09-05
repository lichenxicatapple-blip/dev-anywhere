import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { readProcessArgv } from "#src/common/managed-session-process.js";
import { readParentProcessId } from "#src/common/process-ancestry.js";
import { probeProcess } from "#src/common/process-probe.js";
import { terminateOwnedProcessTree } from "#src/common/process-termination.js";

const queries = vi.hoisted(
  () =>
    [] as Array<{
      elapsedMs: number;
      status: number | null;
      signal: NodeJS.Signals | null;
      errorCode?: string;
      stdout: string;
      stderr: string;
    }>,
);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    // Preserve every real call and return value; only retain bounded evidence for failed assertions.
    spawnSync: (...args: Parameters<typeof actual.spawnSync>) => {
      const started = performance.now();
      const result = actual.spawnSync(...args);
      if (args[0] === "powershell.exe") {
        queries.push({
          elapsedMs: Math.round(performance.now() - started),
          status: result.status,
          signal: result.signal,
          errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
          stdout: String(result.stdout ?? "").slice(-2_048),
          stderr: String(result.stderr ?? "").slice(-2_048),
        });
      }
      return result;
    },
  };
});

describe.skipIf(process.platform !== "win32")("native Windows process management", () => {
  it("reads native argv and terminates only the directly owned process subtree", async () => {
    // Both processes self-expire as a last resort if the test runner itself exits.
    const script = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });",
      "console.log(child.pid);",
      "setTimeout(() => {}, 20000);",
    ].join("\n");
    const args = ["C:\\开发项目\\a b\\", 'quoted "value"', ""];
    const child = spawn(process.execPath, ["-e", script, "--", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const closed = once(child, "close");
    try {
      const [chunk] = await once(child.stdout, "data");
      const descendantPid = Number(String(chunk).trim());
      expect(descendantPid).toBeGreaterThan(0);
      expect(
        readProcessArgv(child.pid!)?.slice(-args.length),
        JSON.stringify(queries.at(-1)),
      ).toEqual(args);
      expect(readParentProcessId(child.pid!), JSON.stringify(queries.at(-1))).toBe(process.pid);
      expect(readParentProcessId(descendantPid), JSON.stringify(queries.at(-1))).toBe(child.pid);
      expect(terminateOwnedProcessTree(child)).toBe(true);
      await closed;
      expect(probeProcess(descendantPid).status).toBe("not-found");
      expect(probeProcess(process.pid).status).toBe("alive");
      console.info(
        "Native Windows process query durations (ms):",
        queries.map((q) => q.elapsedMs),
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) terminateOwnedProcessTree(child);
      await closed;
    }
  }, 30_000);
});
