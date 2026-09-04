import { describe, expect, it } from "vitest";
import { processArgvMatchesManagedSession } from "#src/common/managed-session-process.js";

describe("managed session process identity", () => {
  const workerSocketPath = "/Users/dev/.dev-anywhere/default/data/session-1/worker.sock";

  it.each([
    [
      "development",
      [
        "/usr/local/bin/node",
        "--import",
        "tsx",
        "/workspace/dev-anywhere/apps/proxy/src/session-worker.ts",
        "session-1",
        workerSocketPath,
        "--provider",
        "codex",
        "--",
      ],
    ],
    [
      "production",
      [
        "/usr/local/bin/node",
        "/usr/local/lib/node_modules/dev-anywhere/dist/session-worker.js",
        "session-1",
        workerSocketPath,
        "--provider",
        "codex",
        "--",
      ],
    ],
  ])("recognizes a %s JSON worker by entry, session id, and socket", (_label, argv) => {
    expect(
      processArgvMatchesManagedSession(argv, {
        id: "session-1",
        mode: "json",
        provider: "codex",
        workerSocketPath,
      }),
    ).toBe(true);
  });

  it("requires the JSON worker provider flag to match the persisted provider", () => {
    const argv = [
      "/usr/local/bin/node",
      "/workspace/dev-anywhere/apps/proxy/src/session-worker.ts",
      "session-1",
      workerSocketPath,
      "--provider",
      "claude",
      "--",
      "codex",
    ];
    expect(
      processArgvMatchesManagedSession(argv, {
        id: "session-1",
        mode: "json",
        provider: "codex",
        workerSocketPath,
      }),
    ).toBe(false);
  });

  it("does not accept JSON identity fields merely appearing elsewhere in argv", () => {
    expect(
      processArgvMatchesManagedSession(
        [
          "/usr/local/bin/node",
          "/workspace/dev-anywhere/apps/proxy/src/session-worker.ts",
          "different-session",
          "/tmp/different.sock",
          "--provider",
          "codex",
          "--",
          "session-1",
          workerSocketPath,
        ],
        {
          id: "session-1",
          mode: "json",
          provider: "codex",
          workerSocketPath,
        },
      ),
    ).toBe(false);
  });

  it.each([
    ["entry", "/tmp/unrelated.js", "session-1", workerSocketPath],
    [
      "session id",
      "/workspace/dev-anywhere/apps/proxy/src/session-worker.ts",
      "session-2",
      workerSocketPath,
    ],
    [
      "socket",
      "/workspace/dev-anywhere/apps/proxy/src/session-worker.ts",
      "session-1",
      "/tmp/other.sock",
    ],
  ])("rejects a JSON PID when its %s does not match", (_label, entry, sessionId, socketPath) => {
    expect(
      processArgvMatchesManagedSession(
        ["/usr/local/bin/node", entry, sessionId, socketPath, "--provider", "codex", "--"],
        {
          id: "session-1",
          mode: "json",
          provider: "codex",
          workerSocketPath,
        },
      ),
    ).toBe(false);
  });

  it("recognizes a Shell terminal worker by its exact positional session id", () => {
    expect(
      processArgvMatchesManagedSession(
        [
          "/usr/local/bin/node",
          "/workspace/dev-anywhere/apps/proxy/dist/terminal-worker.js",
          "--profile",
          "default",
          "terminal-1",
          "/tmp",
          "Shell",
          "80",
          "24",
        ],
        {
          id: "terminal-1",
          mode: "pty",
          provider: "claude",
          ptyOwner: "local-terminal",
        },
      ),
    ).toBe(true);
  });

  it("rejects a Shell terminal worker when the id only appears in another argument", () => {
    expect(
      processArgvMatchesManagedSession(
        [
          "/usr/local/bin/node",
          "/workspace/dev-anywhere/apps/proxy/dist/terminal-worker.js",
          "different-session",
          "/tmp/session-1",
          "Shell",
          "80",
          "24",
        ],
        {
          id: "session-1",
          mode: "pty",
          provider: "claude",
          ptyOwner: "local-terminal",
        },
      ),
    ).toBe(false);
  });

  it("recognizes a local Agent terminal only with a DEV Anywhere entry and provider", () => {
    expect(
      processArgvMatchesManagedSession(
        [
          "/usr/local/bin/node",
          "/workspace/dev-anywhere/apps/proxy/dist/index.js",
          "--profile",
          "default",
          "kimi",
        ],
        {
          id: "terminal-1",
          mode: "pty",
          provider: "kimi",
          ptyOwner: "local-terminal",
        },
      ),
    ).toBe(true);
    expect(
      processArgvMatchesManagedSession(["/usr/local/bin/node", "/tmp/index.js", "kimi"], {
        id: "terminal-1",
        mode: "pty",
        provider: "kimi",
        ptyOwner: "local-terminal",
      }),
    ).toBe(false);
  });

  it("parses the local Agent command instead of matching a provider name anywhere in argv", () => {
    const entry = "/workspace/dev-anywhere/apps/proxy/dist/index.js";
    expect(
      processArgvMatchesManagedSession(["/usr/local/bin/node", entry, "serve", "status", "kimi"], {
        id: "terminal-1",
        mode: "pty",
        provider: "kimi",
        ptyOwner: "local-terminal",
      }),
    ).toBe(false);
    expect(
      processArgvMatchesManagedSession(
        ["/usr/local/bin/node", entry, "claude", "--prompt", "kimi"],
        {
          id: "terminal-1",
          mode: "pty",
          provider: "kimi",
          ptyOwner: "local-terminal",
        },
      ),
    ).toBe(false);
  });

  it("never treats a proxy-hosted PTY as a handover-owned process", () => {
    expect(
      processArgvMatchesManagedSession(
        ["/usr/local/bin/node", "/workspace/dev-anywhere/apps/proxy/dist/index.js", "kimi"],
        {
          id: "terminal-1",
          mode: "pty",
          provider: "kimi",
          ptyOwner: "proxy-hosted",
        },
      ),
    ).toBe(false);
  });
});
