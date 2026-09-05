import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_PROVIDER, CODEX_PROVIDER, KIMI_PROVIDER } from "#src/providers/index.js";
import { spawnCommand } from "#src/common/command-launch.js";

const roots: string[] = [];
const PROVIDERS = { claude: CLAUDE_PROVIDER, codex: CODEX_PROVIDER, kimi: KIMI_PROVIDER };
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("provider working directory", () => {
  for (const provider of ["claude", "codex", "kimi"] as const) {
    it.each(["PATH", "override"] as const)(
      `${provider} resolves %s from the child directory and launches there`,
      async (source) => {
        const root = mkdtempSync(join(tmpdir(), `dev-anywhere-${provider}-cwd-`));
        roots.push(root);
        const bin = join(root, "tools");
        mkdirSync(bin);
        const windows = process.platform === "win32";
        const script = join(root, "fake-cli.cjs");
        writeFileSync(
          script,
          "process.stdout.write(JSON.stringify({cwd: process.cwd(), args: process.argv.slice(2)}))",
        );
        const name = `${provider}${windows ? ".cmd" : ""}`;
        const executable = join(bin, name);
        if (windows) {
          writeFileSync(
            executable,
            `@"${process.execPath.replace(/%/g, "%%")}" "${script.replace(/%/g, "%%")}" %*\r\n`,
          );
        } else {
          writeFileSync(
            executable,
            `#!${process.execPath}\n` +
              "process.stdout.write(JSON.stringify({cwd: process.cwd(), args: process.argv.slice(2)}))",
          );
          chmodSync(executable, 0o755);
        }
        const env = Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              !["path", "pathext", "claude_bin", "codex_bin", "kimi_bin"].includes(
                key.toLowerCase(),
              ),
          ),
        );
        env.PATH = "tools";
        if (windows) env.PATHEXT = ".CMD";
        if (source === "override") env[`${provider.toUpperCase()}_BIN`] = `./tools/${name}`;
        const commands = [
          PROVIDERS[provider].buildJsonCommand({ cwd: root }, env),
          PROVIDERS[provider].buildTerminalCommand({ args: [], cwd: root }, env),
        ];
        for (const command of commands) {
          const child = spawnCommand(command.command, command.args, {
            cwd: root,
            env: command.env,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout!.on("data", (data: Buffer) => {
            stdout += data.toString();
          });
          child.stderr!.on("data", (data: Buffer) => {
            stderr += data.toString();
          });
          try {
            const code = await new Promise<number | null>((resolve, reject) => {
              child.once("error", reject);
              child.once("close", resolve);
            });
            expect(code, stderr).toBe(0);
            expect(realpathSync(JSON.parse(stdout).cwd)).toBe(realpathSync(root));
            expect(JSON.parse(stdout).args).toEqual(command.args);
          } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill();
          }
        }
      },
    );
  }
});
