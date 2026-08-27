import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  classifyCodexActiveWriterError,
  codexActiveWriterMessage,
  sanitizeProviderErrorTail,
} from "#src/common/codex-session-conflict.js";

describe("Codex session conflict diagnostics", () => {
  const threadId = "019fa141-cdaf-78a2-a6c1-9cca04fb9f9a";

  it("classifies the canonical app-server active-writer error", () => {
    expect(
      classifyCodexActiveWriterError(
        `thread/resume failed: thread ${threadId} already has an active writer (code -32600)`,
      ),
    ).toEqual({ threadId });
  });

  it("keeps only a small redacted error tail", () => {
    const output = [
      "ordinary user terminal output",
      `Error: Failed to resume ${homedir()}/.codex/sessions/private.jsonl`,
      "Authorization failed: Bearer secret-token-value",
      "request failed: https://example.test/path?token=very-secret&ok=1",
      "request timed out: API_KEY=another-secret",
      "connection refused: https://alice:password123@example.test/v1",
    ].join("\n");
    const tail = sanitizeProviderErrorTail(output);

    expect(tail).not.toContain(homedir());
    expect(tail).not.toContain("secret-token-value");
    expect(tail).not.toContain("very-secret");
    expect(tail).not.toContain("another-secret");
    expect(tail).not.toContain("password123");
    expect(tail).not.toContain("ordinary user terminal output");
    expect(tail).toContain("~/.codex/sessions/private.jsonl");
    expect(tail.length).toBeLessThanOrEqual(2048);
  });

  it("does not log arbitrary terminal content when no error line exists", () => {
    expect(sanitizeProviderErrorTail("user prompt\nassistant answer")).toBe("");
  });

  it("states that DEV Anywhere will not terminate the process", () => {
    expect(codexActiveWriterMessage(46559)).toContain("PID 46559");
    expect(codexActiveWriterMessage(46559)).toContain("不会自动终止");
  });
});
