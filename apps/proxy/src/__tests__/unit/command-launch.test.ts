import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareCommandLaunch,
  quoteWindowsArgument,
  spawnCommand,
} from "#src/common/command-launch.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function output(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<string> {
  const child = spawnCommand(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`Command failed (${code}): ${stderr}`)),
    );
  });
  return stdout;
}

describe("command launch", () => {
  it("runs in the requested child directory, including file URL cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "dev-anywhere-cwd-"));
    roots.push(root);
    for (const cwd of [root, pathToFileURL(root)]) {
      const printed = await output(
        process.execPath,
        ["-e", "process.stdout.write(process.cwd())"],
        { cwd },
      );
      // macOS may canonicalize /var to /private/var in the child's current directory.
      const { realpathSync } = await import("node:fs");
      expect(realpathSync(printed)).toBe(realpathSync(root));
    }
  });

  it("preserves native argv including shell metacharacters and newlines", async () => {
    const args = [
      "",
      "a b",
      'say "hello"',
      "a&b|c",
      "%PATH%",
      "!bang!",
      "C:\\path\\",
      "line1\nline2",
      "中文",
    ];
    expect(
      JSON.parse(
        await output(process.execPath, [
          "-e",
          "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
          ...args,
        ]),
      ),
    ).toEqual(args);
  });

  it("leaves POSIX execution shell-free and unchanged", () => {
    const env = { PATH: "/usr/bin" };
    expect(prepareCommandLaunch("/bin/tool", ["a&b", "line1\nline2"], env, "darwin")).toEqual({
      command: "/bin/tool",
      args: ["a&b", "line1\nline2"],
      env,
    });
  });

  it("keeps Windows native executables outside CMD", () => {
    const launch = prepareCommandLaunch("C:\\tools\\codex.exe", ["a&b", "%PATH%"], {}, "win32");
    expect(launch).toEqual({ command: "C:\\tools\\codex.exe", args: ["a&b", "%PATH%"], env: {} });
  });

  it.each(["tool.cmd", "tool.bat", "C:\\Windows\\System32\\cmd.exe"])(
    "rejects UNC working directories before launching CMD: %s",
    (command) => {
      for (const cwd of ["\\\\server\\share\\project", "//server/share/project"]) {
        expect(() => prepareCommandLaunch(command, [], {}, "win32", cwd)).toThrow(
          "Windows CMD 不支持",
        );
      }
    },
  );

  it("does not reject native executables or mapped drive working directories", () => {
    expect(
      prepareCommandLaunch("C:\\tools\\agent.exe", [], {}, "win32", "\\\\server\\share\\project")
        .command,
    ).toBe("C:\\tools\\agent.exe");
    expect(
      prepareCommandLaunch("C:\\tools\\agent.cmd", [], {}, "win32", "Z:\\project").command,
    ).toMatch(/cmd\.exe$/i);
  });

  it("prepares one escaped CMD command line shared by pipes and PTY", () => {
    const launch = prepareCommandLaunch(
      "C:\\Agent Tools\\kimi.cmd",
      ["a&b", "%PATH%", "!value!", 'quoted "value"'],
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      "win32",
    );
    expect(launch.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(launch.args.slice(0, 4)).toEqual(["/d", "/s", "/v:off", "/c"]);
    expect(launch.args[4]).toContain("Agent^ Tools");
    expect(launch.args[4]).toContain("a^&b");
    expect(launch.args[4]).toContain("^%PATH^%");
    expect(launch.args[4]).toContain("^!value^!");
    expect(launch.windowsVerbatimArguments).toBe(true);
    expect(launch.ptyArgs).toBe(launch.args.join(" "));
  });

  it("preserves the second parsing pass of npm's local .bin shims", () => {
    const launch = prepareCommandLaunch(
      "C:\\project\\node_modules\\.bin\\tool.cmd",
      ["a&b"],
      {},
      "win32",
    );
    expect(launch.args[4]).toContain("a^^^&b");
  });

  it.each(["x\ncalc", "x\rcalc", "x\0calc"])(
    "rejects batch argument control characters: %j",
    (argument) => {
      expect(() => prepareCommandLaunch("tool.cmd", [argument], {}, "win32")).toThrow(
        "cannot accept line breaks or NUL",
      );
    },
  );

  it("refuses an accidental shell-mode override", () => {
    expect(() => spawnCommand("echo", ["a&b"], { shell: true })).toThrow(
      "does not accept shell mode",
    );
  });

  it.each([
    ["", '""'],
    ["plain", '"plain"'],
    ["two words", '"two words"'],
    ['a"b', '"a\\"b"'],
    ["C:\\folder\\", '"C:\\folder\\\\"'],
    ["a&b %PATH%", '"a&b %PATH%"'],
  ])("quotes native Windows argv without applying shell rules: %j", (value, expected) => {
    expect(quoteWindowsArgument(value)).toBe(expected);
  });

  it.skipIf(process.platform !== "win32")(
    "resolves a relative PATH against the child cwd before selecting the batch launcher",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "dev-anywhere-child-cwd-"));
      roots.push(root);
      const bin = join(root, "tools");
      mkdirSync(bin);
      const script = join(root, "where.cjs");
      const shim = join(bin, "cwd-probe.cmd");
      writeFileSync(script, "process.stdout.write(process.cwd())");
      writeFileSync(
        shim,
        `@"${process.execPath.replace(/%/g, "%%")}" "${script.replace(/%/g, "%%")}"\r\n`,
      );
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => key.toLowerCase() !== "path" && key.toLowerCase() !== "pathext",
        ),
      );
      env.Path = "tools";
      env.PATHEXT = ".CMD";
      expect(prepareCommandLaunch("cwd-probe", [], env, "win32", root).args[4]).toContain(
        "cwd-probe.CMD",
      );
      expect(await output("cwd-probe", [], { cwd: root, env })).toBe(root);
      expect(await output("cwd-probe", [], { cwd: pathToFileURL(root), env })).toBe(root);
    },
  );

  it.skipIf(process.platform !== "win32")(
    "round-trips arguments through a real Windows batch shim",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "dev-anywhere-cmd-"));
      roots.push(root);
      const script = join(root, "arguments.cjs");
      const shim = join(root, "tool.cmd");
      writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
      writeFileSync(
        shim,
        `@"${process.execPath.replace(/%/g, "%%")}" "${script.replace(/%/g, "%%")}" %*\r\n`,
      );
      const args = [
        "",
        "two words",
        'quoted "value"',
        "a&b",
        "(a|b)",
        "%PATH%",
        "!value!",
        "C:\\dir\\",
        "中文",
      ];
      expect(JSON.parse(await output(shim, args))).toEqual(args);
    },
  );
});
