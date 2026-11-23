import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.skipIf(process.platform === "win32")(
  "delivers a fast Cursor IDE startup error after the daemon connects",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "cursor-ide-ipc-"));
    const socketPath = join(directory, "worker.sock");
    const sessionId = "cursor-ide-error-check";
    const preload = `data:text/javascript,${encodeURIComponent(
      "globalThis.fetch = async () => ({ ok: true, json: async () => [] });",
    )}`;
    const entry = fileURLToPath(new URL("../../session-worker.ts", import.meta.url));
    const child = spawn(
      process.execPath,
      [
        "--import",
        preload,
        "--import",
        "tsx",
        entry,
        sessionId,
        socketPath,
        "--provider",
        "cursor",
        "--cwd",
        directory,
        "--resume",
        "cursor_ide_c3bc842d-97dc-4cec-9cde-00f07cac3f02",
        "--cursor-ide",
      ],
      { stdio: "ignore" },
    );
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(socketPath); attempt++) await delay(30);
      expect(existsSync(socketPath)).toBe(true);
      // The real daemon does not connect immediately after spawning the worker.
      await delay(300);
      expect(child.exitCode).toBeNull();
      const socket = createConnection(socketPath);
      try {
        const failure = new Promise<string>((resolve, reject) => {
          let pending = "";
          const timeout = setTimeout(
            () => reject(new Error("worker startup error timed out")),
            5000,
          );
          socket.on("error", (error) => {
            clearTimeout(timeout);
            reject(error);
          });
          socket.on("data", (chunk) => {
            pending += chunk.toString();
            const lines = pending.split("\n");
            pending = lines.pop() ?? "";
            for (const line of lines) {
              const message = JSON.parse(line) as { type: string; message?: string };
              if (message.type === "worker_startup_error") {
                clearTimeout(timeout);
                resolve(message.message ?? "");
              }
            }
          });
        });
        socket.write(
          JSON.stringify({
            type: "serve_protocol_hello",
            protocolVersion: 1,
            sessionId,
            pid: process.pid,
          }) + "\n",
        );
        await expect(failure).resolves.toContain("刷新列表");
      } finally {
        socket.destroy();
      }
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
      rmSync(directory, { recursive: true, force: true });
    }
  },
  10_000,
);
