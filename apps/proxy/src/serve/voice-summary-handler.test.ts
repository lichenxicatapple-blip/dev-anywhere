import { describe, expect, it, vi } from "vitest";
import { ControlErrorCode, RelayControlSchema } from "@dev-anywhere/shared";
import {
  VoiceSummaryHandler,
  buildClaudeSpeechSummaryCommand,
  type VoiceSummaryRunner,
} from "./voice-summary-handler.js";
import type { SessionManager } from "./session-manager.js";

function parseSent(raw: string) {
  return RelayControlSchema.parse(JSON.parse(raw));
}

describe("VoiceSummaryHandler", () => {
  it("runs a read-only Claude summary in the session cwd and caches identical requests", async () => {
    const relaySend = vi.fn();
    const runner: VoiceSummaryRunner = vi.fn(async () => "检查新增语音控制器和测试。");
    const handler = new VoiceSummaryHandler({
      relaySend,
      getProviderEnv: () => ({ CLAUDE_BIN: "/bin/claude" }),
      sessionManager: {
        getSession: () => ({ id: "s1", mode: "json", cwd: "/repo", provider: "claude" }),
      } as unknown as SessionManager,
      runner,
    });

    await handler.onVoiceSummaryRequest({
      type: "voice_summary_request",
      requestId: "req-1",
      sessionId: "s1",
      messageId: "m1",
      reason: "code",
      text: "```ts\nconst ok = true;\n```",
    });
    await handler.onVoiceSummaryRequest({
      type: "voice_summary_request",
      requestId: "req-2",
      sessionId: "s1",
      messageId: "m1",
      reason: "code",
      text: "```ts\nconst ok = true;\n```",
    });

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/repo", timeoutMs: 12_000 }),
    );
    const first = parseSent(relaySend.mock.calls[0][0]);
    expect(first).toMatchObject({
      type: "voice_summary_response",
      requestId: "req-1",
      sessionId: "s1",
      messageId: "m1",
      success: true,
      summary: "检查新增语音控制器和测试。",
    });
    const second = parseSent(relaySend.mock.calls[1][0]);
    expect(second).toMatchObject({
      type: "voice_summary_response",
      requestId: "req-2",
      success: true,
      summary: "检查新增语音控制器和测试。",
    });
  });

  it("returns a structured failure when the session is missing", async () => {
    const relaySend = vi.fn();
    const handler = new VoiceSummaryHandler({
      relaySend,
      getProviderEnv: () => ({}),
      sessionManager: { getSession: () => undefined } as unknown as SessionManager,
      runner: vi.fn(),
    });

    await handler.onVoiceSummaryRequest({
      type: "voice_summary_request",
      requestId: "req-1",
      sessionId: "missing",
      messageId: "m1",
      reason: "table",
      text: "| a | b |",
    });

    const msg = parseSent(relaySend.mock.calls[0][0]);
    expect(msg).toMatchObject({
      type: "voice_summary_response",
      requestId: "req-1",
      success: false,
      errorCode: ControlErrorCode.SESSION_NOT_FOUND,
    });
  });

  it("builds the Claude command with read-only tools and no session persistence", () => {
    const command = buildClaudeSpeechSummaryCommand({
      env: { CLAUDE_BIN: "/custom/claude" },
      prompt: "Summarize for speech",
    });

    expect(command.command).toBe("/custom/claude");
    expect(command.args).toEqual([
      "-p",
      "--output-format",
      "text",
      "--no-session-persistence",
      "--permission-mode",
      "plan",
      "--tools",
      "Read,Grep,Glob,LS",
      "Summarize for speech",
    ]);
  });
});
