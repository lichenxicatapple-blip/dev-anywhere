import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAgentCliStatus } from "#src/providers/index.js";

describe("provider availability", () => {
  it("reports explicit provider binaries as available", () => {
    const root = mkdtempSync(join(tmpdir(), "dev-anywhere-provider-explicit-"));
    try {
      const claudeBin = join(root, "claude");
      const codexBin = join(root, "codex");
      writeFileSync(claudeBin, "#!/bin/sh\n");
      writeFileSync(codexBin, "#!/bin/sh\n");
      chmodSync(claudeBin, 0o755);
      chmodSync(codexBin, 0o755);
      const status = detectAgentCliStatus({
        CLAUDE_BIN: claudeBin,
        CODEX_BIN: codexBin,
      });

      expect(status).toEqual({
        claude: {
          available: true,
          command: claudeBin,
          suggestions: [claudeBin],
        },
        codex: { available: true, command: codexBin, suggestions: [codexBin] },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports missing provider binaries without throwing", () => {
    const status = detectAgentCliStatus({ PATH: "/definitely/not/a/bin" });

    expect(status.claude.available).toBe(false);
    expect(status.claude.error).toContain("claude not found");
    expect(status.codex.available).toBe(false);
    expect(status.codex.error).toContain("codex not found");
  });

  it("returns saved path suggestions even when detection fails", () => {
    const status = detectAgentCliStatus(
      { PATH: "/definitely/not/a/bin" },
      { suggestions: { claude: ["/home/dev/.local/bin/claude"] } },
    );

    expect(status.claude.available).toBe(false);
    expect(status.claude.suggestions).toEqual(["/home/dev/.local/bin/claude"]);
  });

  it("discovers multiple provider binaries from PATH as selectable suggestions", () => {
    const root = mkdtempSync(join(tmpdir(), "dev-anywhere-provider-path-"));
    try {
      const bin1 = join(root, "bin1");
      const bin2 = join(root, "bin2");
      mkdirSync(bin1);
      mkdirSync(bin2);
      const claude1 = join(bin1, "claude");
      const claude2 = join(bin2, "claude");
      writeFileSync(claude1, "#!/bin/sh\n");
      writeFileSync(claude2, "#!/bin/sh\n");
      chmodSync(claude1, 0o755);
      chmodSync(claude2, 0o755);

      const status = detectAgentCliStatus({ PATH: `${bin1}:${bin2}` });

      expect(status.claude.available).toBe(true);
      expect(status.claude.command).toBe(claude1);
      expect(status.claude.suggestions).toEqual([claude1, claude2]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
