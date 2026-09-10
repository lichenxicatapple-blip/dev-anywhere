import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createSystemServiceAutostart } from "#src/common/system-service-autostart.js";

// Opt in only on disposable CI hosts. Ordinary unit/integration runs never install OS services.
describe.skipIf(
  process.env.DEV_ANYWHERE_TEST_SYSTEM_SERVICE !== "1" || process.platform === "win32",
)("native POSIX system service", () => {
  it("runs in the system manager as the selected user and disabling startup leaves it running", async () => {
    const home = await mkdtemp("/tmp/da-system native-%-");
    const ready = join(home, "ready.json");
    const source = `require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,uid:process.getuid(),home:process.env.HOME,cwd:process.cwd()}));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
    const manager = createSystemServiceAutostart({
      platform: process.platform,
      home,
      profile: "native",
      executable: process.execPath,
      args: ["-e", source, "--"],
      env: { PATH: process.env.PATH, SHELL: "/bin/sh" },
      uid: process.getuid!(),
      username: userInfo().username,
    });
    const sudo = (command: string, args: string[]) =>
      execFileSync("/usr/bin/sudo", ["-n", command, ...args], {
        timeout: 30_000,
        encoding: "utf8",
      });
    try {
      await manager.enable();
      expect(await manager.status()).toBe(true);
      expect(existsSync(ready)).toBe(false);
      await manager.activate();
      const deadline = Date.now() + 20_000;
      while (!existsSync(ready) && Date.now() < deadline) await sleep(100);
      const processInfo = JSON.parse(await readFile(ready, "utf8"));
      expect(processInfo).toMatchObject({
        uid: process.getuid!(),
        home,
        cwd: await realpath(home),
      });
      if (process.platform === "linux") {
        expect(await readFile(`/proc/${processInfo.pid}/cgroup`, "utf8")).toContain(
          `system.slice/${manager.label}.service`,
        );
      } else {
        expect(
          execFileSync("/bin/launchctl", ["print", `system/${manager.label}`], {
            encoding: "utf8",
          }),
        ).toContain(`pid = ${processInfo.pid}`);
      }
      await manager.disable();
      expect(await manager.status()).toBe(false);
      expect(() => process.kill(processInfo.pid, 0)).not.toThrow();
    } finally {
      // Stop only this unique fixture service, including when a readiness assertion failed.
      try {
        if (process.platform === "linux")
          sudo("systemctl", ["--system", "stop", `${manager.label}.service`]);
        else sudo("/bin/launchctl", ["bootout", `system/${manager.label}`]);
      } finally {
        await manager.disable();
        if (process.platform === "darwin")
          sudo("/bin/launchctl", ["enable", `system/${manager.label}`]);
        await rm(home, { recursive: true, force: true });
      }
    }
  }, 60_000);
});
