import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IS_DEV, resolveTopLevelScript } from "#src/common/env.js";
import { processArgvMatchesManagedSession } from "#src/common/managed-session-process.js";

describe("managed session process identity", () => {
  const workerSocketPath = "/Users/dev/.dev-anywhere/default/data/session-1/worker.sock";
  const cliEntryPath = fileURLToPath(resolveTopLevelScript(IS_DEV ? "index.ts" : "index.js"));

  it("recognizes native Windows worker paths with the exact named-pipe identity", () => {
    const socket = String.raw`\\.\pipe\dev-anywhere-profile-session-1-worker`;
    const argv = [
      String.raw`C:\Program Files\nodejs\node.exe`,
      String.raw`C:\Users\dev\AppData\Roaming\npm\node_modules\dev-anywhere\dist\session-worker.js`,
      "session-1",
      socket,
      "--provider",
      "codex",
      "--",
    ];
    const identity = { id: "session-1", mode: "json" as const, provider: "codex" as const };
    expect(processArgvMatchesManagedSession(argv, { ...identity, workerSocketPath: socket })).toBe(
      true,
    );
    expect(
      processArgvMatchesManagedSession(argv, { ...identity, workerSocketPath: `${socket}-other` }),
    ).toBe(false);
  });

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
        ["/usr/local/bin/node", cliEntryPath, "--profile", "default", "kimi"],
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

  it("recognizes a local Agent terminal launched from an absolute development entry", () => {
    expect(
      processArgvMatchesManagedSession(
        [
          "/usr/local/bin/node",
          "--require",
          "/workspace/dev-anywhere/node_modules/tsx/dist/preflight.cjs",
          "--import",
          "file:///workspace/dev-anywhere/node_modules/tsx/dist/loader.mjs",
          cliEntryPath,
          "--",
          "--profile",
          "chaos-run",
          "codex",
        ],
        {
          id: "terminal-1",
          mode: "pty",
          provider: "codex",
          ptyOwner: "local-terminal",
        },
      ),
    ).toBe(true);
  });

  it("parses the local Agent command instead of matching a provider name anywhere in argv", () => {
    const entry = cliEntryPath;
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
      processArgvMatchesManagedSession(["/usr/local/bin/node", cliEntryPath, "kimi"], {
        id: "terminal-1",
        mode: "pty",
        provider: "kimi",
        ptyOwner: "proxy-hosted",
      }),
    ).toBe(false);
  });

  it("recognizes separate checkouts and installations by their own package identity", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-entry-"));
    const identity = {
      id: "terminal-1",
      mode: "pty" as const,
      provider: "kimi" as const,
      ptyOwner: "local-terminal" as const,
    };
    try {
      for (const [name, entryPath] of [
        ["checkout-a", "src/index.ts"],
        ["checkout-b", "src/index.ts"],
        ["install-a", "dist/index.js"],
        ["install-b", "dist/index.js"],
      ]) {
        const packageDir = join(root, name);
        const entry = join(packageDir, entryPath);
        mkdirSync(dirname(entry), { recursive: true });
        writeFileSync(entry, "");
        writeFileSync(
          join(packageDir, "package.json"),
          JSON.stringify({ name: "@dev-anywhere/proxy", bin: { "dev-anywhere": "dist/index.js" } }),
        );
        expect(processArgvMatchesManagedSession([process.execPath, entry, "kimi"], identity)).toBe(
          true,
        );
        expect(
          processArgvMatchesManagedSession([process.execPath, entry, "claude"], identity),
        ).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves a CLI link to its owning package", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-entry-"));
    const entryDir = join(root, "entry");
    const linkDir = join(root, "linked");
    try {
      // Directory junctions do not require Windows symlink privileges.
      mkdirSync(entryDir);
      const entry = join(entryDir, "index.js");
      writeFileSync(entry, "");
      writeFileSync(
        join(entryDir, "package.json"),
        JSON.stringify({ name: "@dev-anywhere/proxy", bin: { "dev-anywhere": "index.js" } }),
      );
      symlinkSync(entryDir, linkDir, process.platform === "win32" ? "junction" : "dir");
      expect(
        processArgvMatchesManagedSession([process.execPath, join(linkDir, "index.js"), "kimi"], {
          id: "terminal-1",
          mode: "pty",
          provider: "kimi",
          ptyOwner: "local-terminal",
        }),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "different package",
      JSON.stringify({ name: "unrelated", bin: { "dev-anywhere": "src/index.ts" } }),
    ],
    ["missing manifest", null],
    ["invalid manifest", "{"],
    ["oversized manifest", " ".repeat(65_537)],
  ])("rejects an unrelated same-name index with %s", (_label, manifest) => {
    const root = mkdtempSync(join(tmpdir(), "cli-entry-"));
    try {
      const entryDir = join(root, "dev-anywhere", "src");
      mkdirSync(entryDir, { recursive: true });
      const entry = join(entryDir, "index.ts");
      writeFileSync(entry, "");
      if (manifest !== null) writeFileSync(join(root, "dev-anywhere", "package.json"), manifest);
      expect(
        processArgvMatchesManagedSession([process.execPath, entry, "kimi"], {
          id: "terminal-1",
          mode: "pty",
          provider: "kimi",
          ptyOwner: "local-terminal",
        }),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
