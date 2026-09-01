import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  CLOUDFLARED_OUTPUT_LIMIT_BYTES,
  startCloudflaredQuickTunnel,
  terminateCloudflaredChild,
} from "#src/common/cloudflared-quick-tunnel.js";

function fakeChild() {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn((_signal?: NodeJS.Signals | number) => {
    queueMicrotask(() => child.emit("exit", 0, "SIGTERM"));
    return true;
  });
  Object.assign(child, {
    pid: 1234,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    kill,
  });
  return { child, stdout, stderr, kill };
}

describe("shared cloudflared Quick Tunnel child management", () => {
  it("rejects when the child refuses or throws while receiving a stop signal", async () => {
    const refused = fakeChild();
    refused.kill.mockReturnValue(false);
    await expect(terminateCloudflaredChild(refused.child)).rejects.toThrow(
      "cloudflared process rejected SIGTERM",
    );

    const throwing = fakeChild();
    throwing.kill.mockImplementation(() => {
      throw new Error("sensitive operating system detail");
    });
    await expect(terminateCloudflaredChild(throwing.child)).rejects.toThrow(
      "cloudflared process could not be signalled with SIGTERM",
    );
    await expect(terminateCloudflaredChild(throwing.child)).rejects.not.toThrow("sensitive");
  });

  it("allows a failed stop to be retried", async () => {
    const stubborn = fakeChild();
    stubborn.kill.mockReturnValueOnce(false).mockImplementationOnce(() => {
      queueMicrotask(() => stubborn.child.emit("exit", 0, "SIGTERM"));
      return true;
    });
    const tunnel = startCloudflaredQuickTunnel({
      cloudflaredBin: "cloudflared",
      originUrl: "http://127.0.0.1:45678",
      configPath: "/tmp/cloudflared.yml",
      spawn: vi.fn(() => stubborn.child) as never,
    });

    await expect(tunnel.stop()).rejects.toThrow("rejected SIGTERM");
    await expect(tunnel.stop()).resolves.toBeUndefined();
    expect(stubborn.kill).toHaveBeenCalledTimes(2);
  });

  it("finds split URL and connection signals, bounds and redacts output, then stops the child", async () => {
    const { child, stdout, stderr, kill } = fakeChild();
    const spawn = vi.fn(() => child);
    const waitForReachability = vi.fn(async () => undefined);
    const tunnel = startCloudflaredQuickTunnel({
      cloudflaredBin: "/opt/bin/cloudflared",
      originUrl: "http://127.0.0.1:45678",
      configPath: "/private/run/cloudflared.yml",
      pidFilePath: "/private/run/cloudflared.pid",
      env: { PATH: "/opt/bin" },
      spawn: spawn as never,
      waitForReachability,
    });

    stdout.write("雪".repeat(CLOUDFLARED_OUTPUT_LIMIT_BYTES));
    stderr.write("https://quiet-river-");
    stderr.write("42.trycloudflare.com ready\nRegistered tunnel connec");
    stderr.write("tion connIndex=0 protocol=quic");
    await expect(tunnel.publicReady).resolves.toBe("https://quiet-river-42.trycloudflare.com");
    expect(waitForReachability).toHaveBeenCalledWith({
      publicUrl: "https://quiet-river-42.trycloudflare.com",
      signal: expect.any(AbortSignal),
      timeoutMs: 60_000,
    });
    expect(Buffer.byteLength(tunnel.getOutput())).toBeLessThanOrEqual(
      CLOUDFLARED_OUTPUT_LIMIT_BYTES,
    );
    expect(tunnel.getOutput()).toContain("[trycloudflare URL redacted]");
    expect(tunnel.getOutput()).not.toContain("quiet-river-42.trycloudflare.com");

    expect(spawn).toHaveBeenCalledWith(
      "/opt/bin/cloudflared",
      [
        "tunnel",
        "--config",
        "/private/run/cloudflared.yml",
        "--no-autoupdate",
        "--grace-period",
        "2s",
        "--protocol",
        "auto",
        "--url",
        "http://127.0.0.1:45678",
        "--loglevel",
        "info",
        "--pidfile",
        "/private/run/cloudflared.pid",
      ],
      { env: { PATH: "/opt/bin" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    await Promise.all([tunnel.stop(), tunnel.stop()]);
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalledWith("SIGKILL");
  });

  it("starts public validation only after URL discovery and connector registration", async () => {
    const { child, stderr } = fakeChild();
    let finishValidation!: () => void;
    const waitForReachability = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishValidation = resolve;
        }),
    );
    const tunnel = startCloudflaredQuickTunnel({
      cloudflaredBin: "cloudflared",
      originUrl: "http://127.0.0.1:45678",
      configPath: "/tmp/cloudflared.yml",
      spawn: vi.fn(() => child) as never,
      waitForReachability,
    });
    const publicReady = tunnel.publicReady;

    stderr.write("https://validation-order.trycloudflare.com");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(waitForReachability).not.toHaveBeenCalled();

    stderr.write("\nRegistered tunnel connection connIndex=0");
    await vi.waitFor(() => expect(waitForReachability).toHaveBeenCalledOnce());
    let settled = false;
    void publicReady.finally(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    finishValidation();
    await expect(publicReady).resolves.toBe("https://validation-order.trycloudflare.com");
    await tunnel.stop();
  });

  it("cancels public reachability when cloudflared exits or is stopped", async () => {
    const createPendingReadiness = () =>
      vi.fn(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("Quick Tunnel readiness cancelled")),
              { once: true },
            );
          }),
      );

    const exitedChild = fakeChild();
    const exitedReadiness = createPendingReadiness();
    const exited = startCloudflaredQuickTunnel({
      cloudflaredBin: "cloudflared",
      originUrl: "http://127.0.0.1:45678",
      configPath: "/tmp/cloudflared.yml",
      spawn: vi.fn(() => exitedChild.child) as never,
      waitForReachability: exitedReadiness,
    });
    const exitedPublicReady = exited.publicReady;
    exitedChild.stderr.write(
      "https://exit-during-ready.trycloudflare.com\nRegistered tunnel connection",
    );
    await vi.waitFor(() => expect(exitedReadiness).toHaveBeenCalledOnce());
    exitedChild.child.emit("exit", 1, null);
    await expect(exitedPublicReady).rejects.toThrow("readiness cancelled");

    const stoppedChild = fakeChild();
    const stoppedReadiness = createPendingReadiness();
    const stopped = startCloudflaredQuickTunnel({
      cloudflaredBin: "cloudflared",
      originUrl: "http://127.0.0.1:45678",
      configPath: "/tmp/cloudflared.yml",
      spawn: vi.fn(() => stoppedChild.child) as never,
      waitForReachability: stoppedReadiness,
    });
    const stoppedPublicReady = stopped.publicReady;
    stoppedChild.stderr.write(
      "https://stop-during-ready.trycloudflare.com\nRegistered tunnel connection",
    );
    await vi.waitFor(() => expect(stoppedReadiness).toHaveBeenCalledOnce());
    await stopped.stop();
    await expect(stoppedPublicReady).rejects.toThrow("readiness cancelled");
  });

  it("times out URL discovery and connection registration independently", async () => {
    const urlOnlyChild = fakeChild();
    const urlOnly = startCloudflaredQuickTunnel({
      cloudflaredBin: "cloudflared",
      originUrl: "http://127.0.0.1:45678",
      configPath: "/tmp/cloudflared.yml",
      urlTimeoutMs: 100,
      connectionTimeoutMs: 5,
      spawn: vi.fn(() => urlOnlyChild.child) as never,
    });
    urlOnlyChild.stderr.write("https://url-only.trycloudflare.com");
    await expect(urlOnly.publicUrl).resolves.toBe("https://url-only.trycloudflare.com");
    await expect(urlOnly.connectionReady).rejects.toThrow(
      "did not register a tunnel connection within 0.005s",
    );
    await urlOnly.stop();

    const connectionOnlyChild = fakeChild();
    const connectionOnly = startCloudflaredQuickTunnel({
      cloudflaredBin: "cloudflared",
      originUrl: "http://127.0.0.1:45678",
      configPath: "/tmp/cloudflared.yml",
      urlTimeoutMs: 5,
      connectionTimeoutMs: 100,
      spawn: vi.fn(() => connectionOnlyChild.child) as never,
    });
    connectionOnlyChild.stdout.write("Registered tunnel connection connIndex=0");
    await expect(connectionOnly.connectionReady).resolves.toBeUndefined();
    await expect(connectionOnly.publicUrl).rejects.toThrow(
      "did not provide a trycloudflare.com URL within 0.005s",
    );
    await connectionOnly.stop();
  });

  it("rejects pending signals on exit, process error, and explicit stop without leaking output", async () => {
    const exitedChild = fakeChild();
    const exited = startCloudflaredQuickTunnel({
      cloudflaredBin: "cloudflared",
      originUrl: "http://127.0.0.1:45678",
      configPath: "/tmp/cloudflared.yml",
      spawn: vi.fn(() => exitedChild.child) as never,
    });
    exitedChild.stderr.write("diagnostic from cloudflared");
    exitedChild.child.emit("exit", 1, null);
    await expect(exited.publicUrl).rejects.toThrow("exited before providing a tunnel URL");
    await expect(exited.connectionReady).rejects.toThrow(
      "exited before registering a tunnel connection",
    );

    const erroredChild = fakeChild();
    const errored = startCloudflaredQuickTunnel({
      cloudflaredBin: "cloudflared",
      originUrl: "http://127.0.0.1:45678",
      configPath: "/tmp/cloudflared.yml",
      spawn: vi.fn(() => erroredChild.child) as never,
    });
    erroredChild.child.emit(
      "error",
      Object.assign(
        new Error("failed near https://private-name.trycloudflare.com/sensitive-path"),
        { code: "ECONNRESET" },
      ),
    );
    await expect(errored.publicUrl).rejects.toThrow("cloudflared process failed (ECONNRESET)");
    await expect(errored.connectionReady).rejects.toThrow(
      "cloudflared process failed (ECONNRESET)",
    );
    await expect(errored.publicUrl).rejects.not.toThrow("trycloudflare");

    const stoppedChild = fakeChild();
    const stopped = startCloudflaredQuickTunnel({
      cloudflaredBin: "cloudflared",
      originUrl: "http://127.0.0.1:45678",
      configPath: "/tmp/cloudflared.yml",
      spawn: vi.fn(() => stoppedChild.child) as never,
    });
    await stopped.stop();
    await expect(stopped.publicUrl).rejects.toThrow("stopped before providing a tunnel URL");
    await expect(stopped.connectionReady).rejects.toThrow(
      "stopped before registering a tunnel connection",
    );
    expect(stoppedChild.kill).toHaveBeenCalledOnce();
  });
});
