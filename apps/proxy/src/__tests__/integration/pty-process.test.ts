import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { spawn } from "node-pty";
import { expect, it } from "vitest";

it("starts a real PTY, accepts input, resizes its child and exits normally", async () => {
  const root = mkdtempSync(join(tmpdir(), "dev-anywhere-pty-"));
  const fixture = join(root, "pty-size-child.mjs");
  copyFileSync(fileURLToPath(new URL("./fixtures/pty-size-child.ts", import.meta.url)), fixture);
  const terminal = spawn(process.execPath, [fixture], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: root,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  let output = "";
  let exit: { exitCode: number; signal?: number } | undefined;
  terminal.onData((chunk) => (output = `${output}${chunk}`.slice(-16_384)));
  terminal.onExit((event) => (exit = event));

  function reports(): unknown[] {
    return [...stripVTControlCharacters(output).matchAll(/PTY_PROBE:(\[[^\r\n]*\])/g)].map(
      (match) => JSON.parse(match[1]!) as unknown,
    );
  }

  try {
    await expect.poll(reports, { timeout: 8_000 }).toContainEqual(["ready", 80, 24]);
    terminal.write("probe input-ok\r");
    await expect.poll(reports, { timeout: 5_000 }).toContainEqual(["input-ok", 80, 24]);

    terminal.resize(64, 18);
    // Probe the size exposed to the child until its terminal resize has reached it.
    await expect
      .poll(
        () => {
          terminal.write("probe resized\r");
          return reports();
        },
        { timeout: 5_000 },
      )
      .toContainEqual(["resized", 64, 18]);

    terminal.write("exit\r");
    await expect.poll(() => exit?.exitCode, { timeout: 5_000 }).toBe(0);
  } catch (error) {
    console.error("PTY output before failure:", JSON.stringify(output.slice(-2_048)));
    throw error;
  } finally {
    if (!exit) terminal.kill();
    await expect.poll(() => exit, { timeout: 5_000 }).toBeDefined();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
