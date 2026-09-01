import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KIMI_PROVIDER,
  KimiPermissionModeUnsupportedError,
  resolveKimiAcpMode,
  resolveKimiCommand,
} from "#src/providers/kimi.js";

function withExecutable(name: string, test: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "dev-anywhere-kimi-provider-"));
  try {
    const path = join(dir, name);
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
    test(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Kimi provider", () => {
  it("uses KIMI_BIN before probing PATH", () => {
    withExecutable("kimi", (kimiBin) => {
      expect(resolveKimiCommand({ KIMI_BIN: kimiBin })).toBe(kimiBin);
    });
  });

  it("starts the ACP server for JSON sessions", () => {
    withExecutable("kimi", (kimiBin) => {
      const env = { KIMI_BIN: kimiBin } as NodeJS.ProcessEnv;
      expect(KIMI_PROVIDER.buildJsonCommand({}, env)).toEqual({
        command: kimiBin,
        args: ["acp"],
        env,
      });
    });
  });

  it("maps DEV Anywhere permission modes to Kimi ACP modes", () => {
    expect(resolveKimiAcpMode()).toBe("default");
    expect(resolveKimiAcpMode("default")).toBe("default");
    expect(resolveKimiAcpMode("auto")).toBe("yolo");
    expect(resolveKimiAcpMode("plan")).toBe("plan");
    expect(resolveKimiAcpMode("bypassPermissions")).toBe("auto");
    expect(() => resolveKimiAcpMode("acceptEdits")).toThrow(KimiPermissionModeUnsupportedError);
  });

  it("maps terminal permission modes to Kimi flags", () => {
    withExecutable("kimi", (kimiBin) => {
      const env = { KIMI_BIN: kimiBin, TERM: "xterm" } as NodeJS.ProcessEnv;

      expect(KIMI_PROVIDER.buildTerminalCommand({ args: ["chat"] }, env).args).toEqual(["chat"]);
      expect(
        KIMI_PROVIDER.buildTerminalCommand({ args: ["chat"], permissionMode: "default" }, env).args,
      ).toEqual(["chat"]);
      expect(
        KIMI_PROVIDER.buildTerminalCommand({ args: ["chat"], permissionMode: "auto" }, env).args,
      ).toEqual(["--yolo", "chat"]);
      expect(
        KIMI_PROVIDER.buildTerminalCommand({ args: ["chat"], permissionMode: "plan" }, env).args,
      ).toEqual(["--plan", "chat"]);
      expect(
        KIMI_PROVIDER.buildTerminalCommand(
          { args: ["chat"], permissionMode: "bypassPermissions" },
          env,
        ).args,
      ).toEqual(["--auto", "chat"]);
    });
  });

  it("rejects unsupported terminal permission modes with a typed error", () => {
    withExecutable("kimi", (kimiBin) => {
      expect(() =>
        KIMI_PROVIDER.buildTerminalCommand(
          { args: [], permissionMode: "acceptEdits" },
          { KIMI_BIN: kimiBin },
        ),
      ).toThrow(KimiPermissionModeUnsupportedError);
    });
  });

  it("does not advertise hook support", () => {
    expect(KIMI_PROVIDER.capabilities.supportsHooks).toBe(false);
  });
});
