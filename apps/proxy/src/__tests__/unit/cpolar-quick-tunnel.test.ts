import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  CPOLAR_OUTPUT_LIMIT_BYTES,
  cpolarFailureMessage,
  extractCpolarHttpsUrl,
  startCpolarQuickTunnel,
  terminateCpolarChild,
} from "#src/common/cpolar-quick-tunnel.js";

function fakeChild() {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn((_signal?: NodeJS.Signals | number) => {
    queueMicrotask(() => child.emit("exit", 0, "SIGTERM"));
    return true;
  });
  Object.assign(child, {
    pid: 2345,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    kill,
  });
  return { child, stdout, stderr, kill };
}

describe("cpolar Quick Tunnel child management", () => {
  it("rejects when the child remains alive after forced termination", async () => {
    vi.useFakeTimers();
    try {
      const stubborn = fakeChild();
      stubborn.kill.mockImplementation(() => true);
      const termination = terminateCpolarChild(stubborn.child);
      const rejected = expect(termination).rejects.toThrow(
        "cpolar process did not exit after SIGKILL",
      );

      await vi.advanceTimersByTimeAsync(5_000);
      expect(stubborn.kill).toHaveBeenNthCalledWith(1, "SIGINT");
      expect(stubborn.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      await vi.advanceTimersByTimeAsync(1_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows a failed stop to be retried", async () => {
    const stubborn = fakeChild();
    stubborn.kill.mockReturnValueOnce(false).mockImplementationOnce(() => {
      queueMicrotask(() => stubborn.child.emit("exit", 0, "SIGINT"));
      return true;
    });
    const tunnel = startCpolarQuickTunnel({
      cpolarBin: "cpolar",
      originUrl: "http://127.0.0.1:45678",
      tunnelName: "preview",
      spawn: vi.fn(() => stubborn.child) as never,
    });

    await expect(tunnel.stop()).rejects.toThrow("rejected SIGINT");
    await expect(tunnel.stop()).resolves.toBeUndefined();
    expect(stubborn.kill).toHaveBeenCalledTimes(2);
  });

  it("selects the generated HTTPS URL, verifies it, redacts output and stops idempotently", async () => {
    const { child, stdout, kill } = fakeChild();
    const spawn = vi.fn(() => child);
    const waitForReachability = vi.fn(async () => undefined);
    const tunnel = startCpolarQuickTunnel({
      cpolarBin: "/opt/bin/cpolar",
      originUrl: "http://127.0.0.1:45678",
      tunnelName: "dev-anywhere/preview 1",
      env: { PATH: "/opt/bin" },
      spawn: spawn as never,
      waitForReachability,
    });

    stdout.write("雪".repeat(CPOLAR_OUTPUT_LIMIT_BYTES));
    stdout.write("Tunnel established at http://preview-42.r5.cpolar.top\n");
    stdout.write("Tunnel established at https://preview-42.r5.cpolar.");
    stdout.write("top\n");

    await expect(tunnel.publicReady).resolves.toBe("https://preview-42.r5.cpolar.top");
    expect(waitForReachability).toHaveBeenCalledWith({
      publicUrl: "https://preview-42.r5.cpolar.top",
      signal: expect.any(AbortSignal),
      timeoutMs: 45_000,
    });
    expect(Buffer.byteLength(tunnel.getOutput())).toBeLessThanOrEqual(CPOLAR_OUTPUT_LIMIT_BYTES);
    expect(tunnel.getOutput()).toContain("[cpolar URL redacted]");
    expect(tunnel.getOutput()).not.toContain("preview-42.r5.cpolar.top");
    expect(spawn).toHaveBeenCalledWith(
      "/opt/bin/cpolar",
      [
        "http",
        "-tunnelName=dev-anywhere_preview_1",
        "-region=cn_top",
        "-inspect-addr=127.0.0.1:0",
        "-dashboard=off",
        "-daemon=off",
        "-processMode=single",
        "-proto=https",
        "-log=stdout",
        "-log-level=INFO",
        "45678",
      ],
      { env: { PATH: "/opt/bin" }, stdio: ["ignore", "pipe", "pipe"] },
    );

    await Promise.all([tunnel.stop(), tunnel.stop()]);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith("SIGINT");
  });

  it("accepts only generated cpolar HTTPS domains with strict suffixes", () => {
    expect(
      extractCpolarHttpsUrl('Tunnel established at https://preview-42.r10.vip.cpolar.cn"'),
    ).toBe("https://preview-42.r10.vip.cpolar.cn");
    expect(extractCpolarHttpsUrl("http://preview-42.r5.cpolar.top")).toBeNull();
    expect(extractCpolarHttpsUrl("https://preview-42.r5.cpolar.top.evil.test")).toBeNull();
    expect(extractCpolarHttpsUrl("https://cpolar.top")).toBeNull();
  });

  it("cancels public readiness on exit and classifies actionable account failures", async () => {
    const { child, stderr } = fakeChild();
    const waitForReachability = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("readiness cancelled")), {
            once: true,
          });
        }),
    );
    const tunnel = startCpolarQuickTunnel({
      cpolarBin: "cpolar",
      originUrl: "http://127.0.0.1:45678",
      tunnelName: "preview",
      spawn: vi.fn(() => child) as never,
      waitForReachability,
    });
    const publicReady = tunnel.publicReady;
    stderr.write("https://preview-42.r5.cpolar.top");
    await vi.waitFor(() => expect(waitForReachability).toHaveBeenCalledOnce());
    child.emit("exit", 1, null);
    await expect(publicReady).rejects.toThrow("readiness cancelled");

    expect(cpolarFailureMessage("authentication failed: missing authtoken")).toBe(
      "Cpolar 尚未完成账号认证",
    );
    expect(cpolarFailureMessage("authentication failed: 登录实例超过限制")).toBe(
      "Cpolar 在线进程已达账号上限",
    );
    expect(cpolarFailureMessage("unrelated failure")).toBeNull();
  });
});
