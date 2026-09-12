import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, win32 } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { findExecutableCandidates } from "#src/common/executable.js";
import { PtyRuntime } from "#src/common/pty-runtime.js";
import { resolveRemoteFilePath } from "#src/serve/remote-file-path.js";

const nativeShells =
  process.platform === "win32"
    ? [
        {
          name: "Windows PowerShell",
          path: win32.join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          ),
        },
        { name: "PowerShell 7", path: findExecutableCandidates("pwsh.exe", process.env)[0] },
        {
          name: "CMD",
          path: win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
        },
      ].filter((shell): shell is { name: string; path: string } =>
        Boolean(shell.path && existsSync(shell.path)),
      )
    : [];

function directoryIdentity(path: string): string | undefined {
  if (!path) return undefined;
  const { dev, ino } = statSync(path, { bigint: true });
  return `${dev}:${ino}`;
}

describe.skipIf(process.platform !== "win32")("native Windows Shell working directory", () => {
  it.each(nativeShells)(
    "follows cd in $name and resolves the file from the new directory",
    async ({ name, path }) => {
      const root = mkdtempSync(join(tmpdir(), "dev-anywhere-shell-cwd-"));
      const destination = join(root, "项目 space");
      mkdirSync(destination);
      writeFileSync(join(root, "result.txt"), "OLD_DIRECTORY");
      writeFileSync(join(destination, "result.txt"), "CURRENT_DIRECTORY");
      writeFileSync(join(destination, "only-current.txt"), "NEW_FILE");
      let cwd = "";
      let directoryReports = 0;
      let output = "";
      const runtime = new PtyRuntime(
        {
          kind: "terminal",
          shell: path,
          sessionId: "native-shell-cwd",
          cwd: root,
          cols: 120,
          rows: 24,
          env: { ...process.env, PROMPT: "custom $P$G" },
        },
        {
          cwd: (value) => {
            cwd = value;
            directoryReports++;
          },
          output: (value) => {
            output += value;
          },
          resize() {},
          title() {},
          semantic() {},
          exit() {},
        },
      );
      try {
        runtime.start();
        // PowerShell expands 8.3 aliases such as RUNNER~1; compare directory identity.
        await expect
          .poll(() => directoryIdentity(cwd), { timeout: 15000 })
          .toBe(directoryIdentity(root));
        if (name !== "CMD") {
          const beforeStrictPrompt = directoryReports;
          runtime.write(
            "Set-StrictMode -Version Latest; Remove-Variable LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue\r",
          );
          await expect.poll(() => directoryReports).toBeGreaterThan(beforeStrictPrompt);
        }
        const command =
          name === "CMD"
            ? `cd /d "${destination}"`
            : `Set-Location -LiteralPath '${destination.replaceAll("'", "''")}'`;
        runtime.write(`${command}\r`);
        await expect
          .poll(() => directoryIdentity(cwd), { timeout: 10000 })
          .toBe(directoryIdentity(destination));
        for (const relative of ["result.txt", ".\\result.txt", "./result.txt"]) {
          expect(readFileSync(resolveRemoteFilePath(relative, cwd), "utf8")).toBe(
            "CURRENT_DIRECTORY",
          );
        }
        expect(readFileSync(resolveRemoteFilePath("only-current.txt", cwd), "utf8")).toBe(
          "NEW_FILE",
        );
        expect(readFileSync(resolveRemoteFilePath("..\\result.txt", cwd), "utf8")).toBe(
          "OLD_DIRECTORY",
        );
        expect(
          readFileSync(
            resolveRemoteFilePath(join(destination, "result.txt").slice(2), cwd),
            "utf8",
          ),
        ).toBe("CURRENT_DIRECTORY");
        if (name === "CMD") expect(output).toContain("custom ");
        else {
          const beforeNativeCommand = directoryReports;
          runtime.write("cmd /d /c exit 23\r");
          await expect.poll(() => directoryReports).toBeGreaterThan(beforeNativeCommand);
          const exitCodeFile = join(root, "exit-code.txt");
          runtime.write(
            `[IO.File]::WriteAllText('${exitCodeFile.replaceAll("'", "''")}', [string]$global:LASTEXITCODE)\r`,
          );
          await expect.poll(() => existsSync(exitCodeFile)).toBe(true);
          expect(readFileSync(exitCodeFile, "utf8")).toBe("23");
        }
        console.info(`${name}: current directory and relative file contents verified`);
      } finally {
        await runtime.terminate();
        rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      }
    },
    35000,
  );
});
