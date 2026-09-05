import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServiceAutostart } from "#src/common/service-autostart.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(platform: NodeJS.Platform, profile = "default") {
  const home = await mkdtemp(join(tmpdir(), "da-autostart-"));
  roots.push(home);
  const run = vi.fn(async (_command: string, _args: string[]) => "");
  const options = {
    platform,
    home,
    profile,
    executable: "/usr/local/bin/node",
    args: ["/path with spaces/DEV Anywhere/index.js"],
    env: { PATH: "/usr/bin:/custom/bin", SHELL: "/bin/zsh", RELAY_PROXY_TOKEN: "do-not-save" },
    uid: 501,
    run,
  };
  const manager = createServiceAutostart(options);
  const directory =
    platform === "darwin"
      ? join(home, "Library", "LaunchAgents")
      : join(home, ".config", "systemd", "user");
  const file = async () => join(directory, (await readdir(directory))[0]!);
  return { options, manager, run, directory, file };
}

describe("Proxy login startup registration", () => {
  it("rejects unsupported platforms without executing commands", async () => {
    const { options, run } = await fixture("linux");
    expect(() => createServiceAutostart({ ...options, platform: "freebsd" })).toThrow(
      "not supported",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["darwin", "linux"] as const)(
    "reports absent registration without invoking %s tools",
    async (platform) => {
      const { manager, run } = await fixture(platform);
      expect(await manager.status()).toBe(false);
      await manager.disable();
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("generates a launch agent with exact argv, only PATH/SHELL, and no restart policy", async () => {
    const { manager, file, run } = await fixture("darwin", "local");
    await manager.enable();
    const content = await readFile(await file(), "utf8");
    expect(content).toContain("<string>/path with spaces/DEV Anywhere/index.js</string>");
    expect(content).toContain("<string>--profile</string><string>local</string>");
    expect(content).toContain("<key>RunAtLoad</key><true/>");
    expect(content).toContain("<key>KeepAlive</key><false/>");
    expect(content).not.toContain("do-not-save");
    expect(content).not.toContain("StandardErrorPath");
    expect(run).toHaveBeenCalledExactlyOnceWith("/bin/launchctl", [
      "enable",
      expect.stringMatching(/^gui\/501\/dev-anywhere-/),
    ]);
    if (process.platform === "darwin") {
      const parsed = JSON.parse(
        execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", await file()], {
          encoding: "utf8",
        }),
      );
      expect(parsed.ProgramArguments).toEqual([
        "/usr/local/bin/node",
        "/path with spaces/DEV Anywhere/index.js",
        "--profile",
        "local",
        "serve",
        "autostart",
        "run",
      ]);
      expect(parsed.EnvironmentVariables).toEqual({
        HOME: expect.any(String),
        PATH: "/usr/bin:/custom/bin",
        SHELL: "/bin/zsh",
      });
    }
  });

  it("escapes XML without changing the executable path", async () => {
    const { options, file } = await fixture("darwin");
    const manager = createServiceAutostart({ ...options, executable: '/space & <quote> "a"/node' });
    await manager.enable();
    expect(await readFile(await file(), "utf8")).toContain(
      "/space &amp; &lt;quote&gt; &quot;a&quot;/node",
    );
  });

  it("enables idempotently and disables without unloading a running launch agent", async () => {
    const { manager, directory, run } = await fixture("darwin");
    await manager.enable();
    await manager.enable();
    expect(await readdir(directory)).toHaveLength(1);
    expect(await manager.status()).toBe(true);
    await manager.disable();
    expect(await manager.status()).toBe(false);
    expect(run.mock.calls.map(([, args]) => args[0])).toEqual([
      "enable",
      "enable",
      "print-disabled",
      "disable",
    ]);
  });

  it("recognizes an externally disabled macOS launch agent", async () => {
    const { manager, file, run } = await fixture("darwin");
    await manager.enable();
    const label = (await readFile(await file(), "utf8")).match(
      /<key>Label<\/key><string>([^<]+)<\/string>/,
    )![1];
    run.mockResolvedValue(`disabled services = {\n "${label}" => true\n}`);
    expect(await manager.status()).toBe(false);
  });

  it("registers a Linux oneshot without killing its detached Proxy at command exit", async () => {
    const { manager, file, run } = await fixture("linux");
    await manager.enable();
    const content = await readFile(await file(), "utf8");
    expect(content).toContain("Type=oneshot\nRemainAfterExit=yes\nRestart=no");
    expect(content).toContain('"serve" "autostart" "run" "--daemon"');
    expect(content).not.toMatch(/ExecStop|PIDFile|KillMode/);
    expect(content).not.toContain("do-not-save");
    expect(run.mock.calls.map(([, args]) => args.slice(0, 2))).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "enable"],
    ]);
    run.mockResolvedValue("enabled\n");
    expect(await manager.status()).toBe(true);
    await manager.disable();
    expect(run.mock.calls.some(([, args]) => args.includes("--now") || args.includes("stop"))).toBe(
      false,
    );
    expect(await manager.status()).toBe(false);
  });

  it("quotes systemd specifiers and disables ExecStart environment expansion", async () => {
    const { options, file } = await fixture("linux");
    await createServiceAutostart({
      ...options,
      executable: '/space %h $TOKEN "quoted"/node',
    }).enable();
    expect(await readFile(await file(), "utf8")).toContain(
      'ExecStart=:"/space %%h $TOKEN \\"quoted\\"/node"',
    );
  });

  it.each(["darwin", "linux"] as const)(
    "keeps an earlier %s definition when registration fails",
    async (platform) => {
      const { manager, file, run } = await fixture(platform);
      await manager.enable();
      const path = await file();
      await writeFile(path, "previous registration");
      run.mockRejectedValue(new Error("registration denied"));
      await expect(manager.enable()).rejects.toThrow("registration denied");
      expect(await readFile(path, "utf8")).toBe("previous registration");
    },
  );

  it.each(["darwin", "linux"] as const)(
    "does not leave a new %s definition after failure",
    async (platform) => {
      const { manager, directory, run } = await fixture(platform);
      run.mockRejectedValue(new Error("system manager unavailable"));
      await expect(manager.enable()).rejects.toThrow("system manager unavailable");
      expect(await readdir(directory)).toEqual([]);
    },
  );

  it("isolates profiles even on case-insensitive filesystems", async () => {
    const { options, manager, directory } = await fixture("darwin", "test");
    await manager.enable();
    await createServiceAutostart({ ...options, profile: "TEST" }).enable();
    expect(await readdir(directory)).toHaveLength(2);
    await manager.disable();
    expect(await readdir(directory)).toHaveLength(1);
  });

  it("rejects control characters before writing a registration", async () => {
    const { options, run } = await fixture("darwin");
    await expect(
      createServiceAutostart({ ...options, executable: "a\nb" }).enable(),
    ).rejects.toThrow("control characters");
    expect(run).not.toHaveBeenCalled();
  });

  it("registers a Windows user-login task without storing credentials or relaunching on failure", async () => {
    const { options, run } = await fixture("win32");
    const manager = createServiceAutostart({
      ...options,
      executable: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\DEV Anywhere\\index.js"],
    });
    await manager.enable();
    const [command, args] = run.mock.calls[0]!;
    expect(command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const script = Buffer.from(args[3]!, "base64").toString("utf16le");
    expect(script).toContain("-AtLogOn -User $user");
    expect(script).toContain("-LogonType Interactive -RunLevel Limited");
    expect(script).toContain("-ExecutionTimeLimit ([TimeSpan]::Zero)");
    expect(script).toContain("-Priority 4");
    expect(script).toContain("-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries");
    expect(script).not.toMatch(/Password|RestartCount|Start-ScheduledTask|do-not-save/);
    const encodedLauncher = script.match(
      /-WindowStyle Hidden -EncodedCommand ([a-zA-Z0-9+/=]+)/,
    )![1]!;
    const launcher = Buffer.from(encodedLauncher, "base64").toString("utf16le");
    expect(launcher).toContain("$info.CreateNoWindow = $true");
    expect(launcher).toContain("$info.UseShellExecute = $false");
    expect(launcher).toContain(
      '"C:\\DEV Anywhere\\index.js" "--profile" "default" "serve" "autostart" "run"',
    );
  });

  it("Windows cancellation only deletes its task, without terminating the current Proxy", async () => {
    const { manager, run } = await fixture("win32");
    await manager.disable();
    const script = Buffer.from(run.mock.calls[0]![1][3]!, "base64").toString("utf16le");
    expect(script).toContain("Unregister-ScheduledTask -Confirm:$false");
    expect(script).not.toMatch(/Stop-|taskkill|Terminate/);
  });

  it.each([true, false])("reads structured Windows registration status: %s", async (enabled) => {
    const { manager, run } = await fixture("win32");
    run.mockResolvedValue(JSON.stringify(enabled));
    expect(await manager.status()).toBe(enabled);
  });
});
