import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProxyProfilePaths } from "#src/common/paths.js";
import { requestServiceHost, startServiceHostControl } from "#src/common/service-host-control.js";
import { withSystemServiceHost } from "#src/common/system-service-lifecycle.js";
import type { ServiceLifecycle } from "#src/common/service-lifecycle.js";
import type { ServiceCommandResult } from "#src/common/service-command-result.js";

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const ready: ServiceCommandResult = {
  status: "ready",
  pid: 123,
  instanceId: "instance",
  version: "0.9.8",
  missingSessionIds: [],
};
async function fixture() {
  const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "da-host-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const paths = buildProxyProfilePaths(root, "default");
  await mkdir(paths.runDir, { recursive: true });
  const execute = vi.fn(async (): Promise<ServiceCommandResult> => ready);
  return { paths, execute };
}
async function serve(f: Awaited<ReturnType<typeof fixture>>) {
  const server = await startServiceHostControl({
    endpoint: f.paths.serviceHostPath,
    profile: "default",
    execute: f.execute,
  });
  cleanup.push(server.close);
}
function localLifecycle() {
  return {
    status: vi.fn(async () => null),
    start: vi.fn(),
    restart: vi.fn(),
    stop: vi.fn(),
    startForeground: vi.fn(),
  } satisfies ServiceLifecycle;
}

describe("system service host IPC", () => {
  it("probes independently from Proxy readiness and forwards only bounded lifecycle requests", async () => {
    const f = await fixture();
    await serve(f);
    expect(
      await requestServiceHost(f.paths.serviceHostPath, "default", { action: "probe" }),
    ).toEqual({ status: "host", pid: process.pid });
    expect(f.execute).not.toHaveBeenCalled();
    expect(
      await requestServiceHost(f.paths.serviceHostPath, "default", {
        action: "restart",
        intent: "recover",
        relay: "cloud",
        recoveryToken: "token",
      }),
    ).toEqual(ready);
    expect(f.execute).toHaveBeenCalledWith({
      version: 1,
      profile: "default",
      action: "restart",
      intent: "recover",
      relay: "cloud",
      recoveryToken: "token",
    });
    if (process.platform !== "win32")
      expect((await stat(f.paths.serviceHostPath)).mode & 0o777).toBe(0o600);
  });

  it("refuses other profiles, arbitrary environment and executable fields without executing", async () => {
    const f = await fixture();
    await serve(f);
    await expect(
      requestServiceHost(f.paths.serviceHostPath, "other", { action: "stop" }),
    ).rejects.toThrow("Invalid system service response");
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(f.paths.serviceHostPath);
      let result = "";
      socket.once("connect", () =>
        socket.write(
          `${JSON.stringify({ version: 1, profile: "default", action: "start", executable: "/bin/sh", env: { SECRET: "not-accepted" } })}\n`,
        ),
      );
      socket.on("data", (data) => {
        result += data;
      });
      socket.once("end", () => resolve(result));
      socket.once("error", reject);
    });
    expect(JSON.parse(response).result.status).toBe("failed");
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("distinguishes a missing host from a non-responsive one", async () => {
    const f = await fixture();
    expect(
      await requestServiceHost(f.paths.serviceHostPath, "default", { action: "probe" }),
    ).toBeNull();
    const sockets: Array<ReturnType<typeof connect>> = [];
    const server = createServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => server.listen(f.paths.serviceHostPath, resolve));
    cleanup.push(() => {
      for (const socket of sockets) socket.destroy();
      server.close();
    });
    await expect(
      requestServiceHost(f.paths.serviceHostPath, "default", { action: "start" }, 30),
    ).rejects.toThrow("timed out");
  });

  it("routes restart, foreground start and stop through the host and preserves recovery errors", async () => {
    const f = await fixture();
    await serve(f);
    const local = localLifecycle();
    const routed = withSystemServiceHost(local, {
      endpoint: f.paths.serviceHostPath,
      profile: "default",
      relay: "cloud",
      registered: () => true,
    });
    expect((await routed.restart("recover")).service.pid).toBe(123);
    await routed.startForeground(vi.fn());
    expect(local.restart).not.toHaveBeenCalled();
    expect(local.startForeground).not.toHaveBeenCalled();
    f.execute.mockResolvedValueOnce({ status: "stopped" });
    await routed.stop();
    expect(local.stop).not.toHaveBeenCalled();
    f.execute.mockResolvedValueOnce({
      status: "failed",
      code: "START_FAILED",
      message: "retry",
      recoveryToken: "recovery-token",
    });
    await expect(routed.restart()).rejects.toMatchObject({
      code: "START_FAILED",
      recoveryToken: "recovery-token",
    });
    expect(local.start).not.toHaveBeenCalled();
  });

  it("keeps ordinary lifecycle fallback but never silently starts a configured system service in the desktop session", async () => {
    const f = await fixture();
    const local = localLifecycle();
    let registered = false;
    const routed = withSystemServiceHost(local, {
      endpoint: f.paths.serviceHostPath,
      profile: "default",
      registered: () => registered,
    });
    await routed.start("recover", "token");
    expect(local.start).toHaveBeenCalledExactlyOnceWith("recover", "token");
    registered = true;
    await expect(routed.restart()).rejects.toThrow("system service is not running");
    expect(local.restart).not.toHaveBeenCalled();
    await routed.stop();
    expect(local.stop).toHaveBeenCalledTimes(1);
  });
});
