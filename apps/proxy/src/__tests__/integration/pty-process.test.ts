import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { spawn } from "node-pty";
import { expect, it } from "vitest";
import { PtyRuntime } from "#src/common/pty-runtime.js";

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

it("answers hosted startup color probes inside the CLI deadline without a Web viewer", async () => {
  const root = mkdtempSync(join(tmpdir(), "dev-anywhere-pty-colors-"));
  const fixture = join(root, "pty-color-probe-child.mjs");
  copyFileSync(
    fileURLToPath(new URL("./fixtures/pty-color-probe-child.ts", import.meta.url)),
    fixture,
  );
  let output = "";
  let exit: { exitCode: number } | undefined;
  const runtime = new PtyRuntime(
    {
      sessionId: "native-color-probe",
      kind: "agent",
      provider: "codex",
      args: [fixture],
      cwd: root,
      cols: 80,
      rows: 24,
      env: { ...process.env, NODE_OPTIONS: "", CODEX_BIN: process.execPath },
    },
    {
      output: (data) => (output = `${output}${data}`.slice(-16_384)),
      resize: () => {},
      title: () => {},
      cwd: () => {},
      semantic: () => {},
      exit: (event) => (exit = event),
    },
  );
  try {
    runtime.start();
    await expect
      .poll(() => stripVTControlCharacters(output), { timeout: 8_000 })
      .toMatch(/PTY_COLOR_READY:\d+/);
    // Ordinary input uses the same PTY and remains byte-for-byte intact after terminal probing.
    runtime.write("user input\r");
    await expect.poll(() => exit?.exitCode, { timeout: 5_000 }).toBe(0);
    expect(stripVTControlCharacters(output)).toContain('"error":null');
  } catch (error) {
    console.error("PTY color probe output before failure:", JSON.stringify(output.slice(-2_048)));
    throw error;
  } finally {
    await runtime.terminate();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
