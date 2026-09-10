import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSystemServiceAutostart } from "#src/common/system-service-autostart.js";
import { switchAutostartMode } from "#src/common/autostart-mode.js";
import { buildWindowsService } from "#src/common/windows-service.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(platform: NodeJS.Platform = "darwin") {
  const home = await mkdtemp(join(tmpdir(), "da-system-"));
  roots.push(home);
  const systemDirectory = join(home, "system");
  await mkdir(systemDirectory);
  const scripts: string[] = [];
  const run = vi.fn(async (_command: string, args: string[]) => {
    if (platform !== "win32") return "enabled\n";
    const source = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
    return source.includes("$identity =")
      ? JSON.stringify({ name: "PC\\Developer", sid: "S-1-5-21-123" })
      : "true";
  });
  const interactive = vi.fn(async (_command: string, args: string[]) => {
    if (args[0] === "/usr/bin/install") await copyFile(args.at(-2)!, args.at(-1)!);
    if (args[0] === "/bin/rm") await rm(args.at(-1)!, { force: true });
    if (args.includes("-File")) scripts.push(await readFile(args.at(-1)!, "utf8"));
    return "";
  });
  const options = {
    platform,
    home,
    profile: "work",
    executable: "/usr/local/bin/node",
    args: ["/path with spaces/index.js"],
    env: { PATH: "/usr/bin:/custom", SHELL: "/bin/zsh", RELAY_PROXY_TOKEN: "never-save" },
    uid: 501,
    username: "developer",
    run,
    runInteractive: interactive,
    systemDirectory,
  };
  return {
    home,
    options,
    run,
    interactive,
    scripts,
    manager: createSystemServiceAutostart(options),
  };
}

describe("system startup registration", () => {
  it("installs a macOS system daemon as its owner without touching the running Proxy", async () => {
    const f = await fixture();
    await f.manager.enable();
    const content = await readFile(f.manager.filePath, "utf8");
    expect(content).toContain("<key>UserName</key><string>developer</string>");
    expect(content).toContain("<string>--system</string>");
    expect(content).not.toContain("never-save");
    expect(f.interactive.mock.calls).toContainEqual([
      "/usr/bin/sudo",
      ["/bin/launchctl", "enable", `system/${f.manager.label}`],
    ]);
    expect(f.interactive.mock.calls.flat(2)).not.toContain("bootstrap");
    expect(f.interactive.mock.calls.flat(2)).not.toContain("stop");
    const install = f.interactive.mock.calls[0]![1];
    expect(install.slice(0, 7)).toEqual([
      "/usr/bin/install",
      "-o",
      "root",
      "-g",
      "wheel",
      "-m",
      "644",
    ]);
    if (process.platform === "darwin") {
      const plist = JSON.parse(
        execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", f.manager.filePath], {
          encoding: "utf8",
        }),
      );
      expect(plist.UserName).toBe("developer");
      expect(plist.ProgramArguments).toEqual([
        "/usr/local/bin/node",
        "/path with spaces/index.js",
        "--profile",
        "work",
        "serve",
        "autostart",
        "run",
        "--system",
      ]);
      expect(plist.EnvironmentVariables.HOME).toBe(f.home);
    }
    await f.manager.disable();
    expect(await f.manager.status()).toBe(false);
    expect(f.interactive.mock.calls.flat(2)).not.toContain("bootout");
  });

  it("uses a system-level Linux unit with user credentials, persistent host and boot target", async () => {
    const f = await fixture("linux");
    await f.manager.enable();
    const content = await readFile(f.manager.filePath, "utf8");
    expect(content).toContain("User=developer\n");
    expect(content).toContain(`WorkingDirectory=${f.home}\n`);
    expect(content).toContain("Type=simple");
    expect(content).toContain("WantedBy=multi-user.target");
    expect(content).toContain('"run" "--system"');
    expect(content).not.toMatch(/--daemon|never-save/);
    expect(f.interactive.mock.calls.flat(2)).not.toContain("--user");
    await f.manager.activate();
    expect(f.interactive).toHaveBeenLastCalledWith("/usr/bin/sudo", [
      "systemctl",
      "--system",
      "start",
      `${f.manager.label}.service`,
    ]);
    await f.manager.disable();
    expect(f.interactive.mock.calls.flat(2)).not.toContain("stop");
  });

  it("does not register an accidental root profile, or accept control characters", async () => {
    const f = await fixture();
    await expect(
      createSystemServiceAutostart({ ...f.options, uid: 0, username: "root" }).enable(),
    ).rejects.toThrow("normal user");
    await expect(
      createSystemServiceAutostart({ ...f.options, executable: "a\nb" }).enable(),
    ).rejects.toThrow("control characters");
    expect(f.interactive).not.toHaveBeenCalled();
  });

  it("restores the previous definition after registration fails", async () => {
    const f = await fixture();
    await f.manager.enable();
    await writeFile(f.manager.filePath, "previous definition");
    f.interactive.mockImplementationOnce(async (_command, args) => {
      await copyFile(args.at(-2)!, args.at(-1)!);
      return "";
    });
    f.interactive.mockRejectedValueOnce(new Error("denied"));
    await expect(f.manager.enable()).rejects.toThrow("denied");
    expect(await readFile(f.manager.filePath, "utf8")).toBe("previous definition");
  });

  it("bootstraps an unloaded macOS daemon only for explicit activation", async () => {
    const f = await fixture();
    f.run.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: 113 }));
    await f.manager.activate();
    expect(f.interactive).toHaveBeenLastCalledWith("/usr/bin/sudo", [
      "/bin/launchctl",
      "bootstrap",
      "system",
      f.manager.filePath,
    ]);
    f.run.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: 1 }));
    await expect(f.manager.activate()).rejects.toThrow("denied");
  });

  it("installs Windows SCM service for the pre-UAC identity and keeps passwords out of artifacts", async () => {
    const f = await fixture("win32");
    await f.manager.enable();
    const script = f.scripts[0]!;
    expect(script).toContain("-Verb RunAs -Wait -PassThru");
    expect(script).toContain("$ownerName = 'PC\\Developer'");
    expect(script).toContain("$ownerSid = 'S-1-5-21-123'");
    expect(script).toContain("Get-Credential -UserName $ownerName");
    expect(script).toContain("ServiceProcessInstaller");
    expect(script).toContain("$processInstaller.Rollback($state)");
    expect(script).not.toContain("never-save");
    expect(script).not.toMatch(/LocalSystem|Start-Service|AtLogOn|Export-Clixml/);
    expect(f.interactive.mock.calls[0]![1]).toEqual([
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      expect.stringMatching(/register\.ps1$/),
    ]);
    await expect(readFile(f.interactive.mock.calls[0]![1].at(-1)!, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await f.manager.disable();
    expect(f.scripts[1]).toContain("StartMode = 'Disabled'");
    expect(f.scripts[1]).not.toMatch(/Stop-Service|Delete\(/);
  });

  it("uses an immutable SCM wrapper with a private graceful-stop pipe", () => {
    const wrapper = buildWindowsService({
      home: "C:\\Users\\O'Neil",
      profile: "work",
      label: "dev-anywhere-test",
      executable: "C:\\Program Files\\nodejs\\node.exe",
      args: ["a b", "trailing\\", '"quotes"'],
      env: { HOME: "C:\\Users\\O'Neil" },
    });
    expect(wrapper.path).toMatch(/service-[a-f0-9]{20}\.exe$/);
    expect(wrapper.source).toContain("ServiceBase.Run(service)");
    expect(wrapper.source).toContain('child.StandardInput.WriteLine("stop")');
    expect(wrapper.source).toContain("info.UseShellExecute = false");
    expect(wrapper.source).toContain("info.RedirectStandardInput = true");
    expect(wrapper.compileScript).toContain("System.ServiceProcess.dll");
    expect(wrapper.compileScript).toContain("O''Neil");
  });

  it("keeps the previous startup mode when replacement registration fails", async () => {
    const selected = {
      status: vi.fn(async () => false),
      enable: vi.fn(async () => {
        throw new Error("denied");
      }),
      disable: vi.fn(),
    };
    const previous = { status: vi.fn(async () => true), enable: vi.fn(), disable: vi.fn() };
    await expect(switchAutostartMode(selected, previous)).rejects.toThrow("denied");
    expect(previous.disable).not.toHaveBeenCalled();
    selected.enable.mockResolvedValueOnce(undefined as never);
    previous.disable.mockRejectedValueOnce(new Error("cannot remove old startup"));
    await expect(switchAutostartMode(selected, previous)).rejects.toThrow("cannot remove");
    expect(previous.enable).toHaveBeenCalledTimes(1);
    expect(selected.disable).toHaveBeenCalledTimes(1);
  });

  it("keeps profiles isolated in the system directory", async () => {
    const f = await fixture();
    await f.manager.enable();
    const second = createSystemServiceAutostart({ ...f.options, profile: "Work" });
    await second.enable();
    expect(await readdir(f.options.systemDirectory)).toHaveLength(2);
    await second.disable();
    expect(await f.manager.status()).toBe(true);
  });
});
