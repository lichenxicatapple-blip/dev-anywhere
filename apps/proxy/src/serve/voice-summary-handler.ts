import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  ControlErrorCode,
  serializeControl,
  type ControlMessage,
  type VoiceSummaryReason,
} from "@dev-anywhere/shared";
import { serviceLogger } from "../common/logger.js";
import type { SessionManager } from "./session-manager.js";
import type { RelaySend } from "./relay-router-types.js";
import { buildVoiceSummaryPrompt } from "./voice-summary-prompt.js";

const SUMMARY_TIMEOUT_MS = 12_000;

export interface VoiceSummaryRunnerOptions {
  cwd: string;
  prompt: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export type VoiceSummaryRunner = (options: VoiceSummaryRunnerOptions) => Promise<string>;

interface BuildClaudeSpeechSummaryCommandOptions {
  env: NodeJS.ProcessEnv;
  prompt: string;
}

interface ClaudeSpeechSummaryCommand {
  command: string;
  args: string[];
}

export function buildClaudeSpeechSummaryCommand({
  env,
  prompt,
}: BuildClaudeSpeechSummaryCommandOptions): ClaudeSpeechSummaryCommand {
  return {
    command: env.CLAUDE_BIN || "claude",
    args: [
      "-p",
      "--output-format",
      "text",
      "--no-session-persistence",
      "--permission-mode",
      "plan",
      "--tools",
      "Read,Grep,Glob,LS",
      prompt,
    ],
  };
}

export const runClaudeSpeechSummary: VoiceSummaryRunner = ({ cwd, prompt, env, timeoutMs }) => {
  const { command, args } = buildClaudeSpeechSummaryCommand({ env, prompt });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("Claude speech summary timed out"));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
      if (code === 0 && stdout.length > 0) {
        resolve(stdout);
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      reject(new Error(stderr || `Claude speech summary exited with code ${code ?? "unknown"}`));
    });
  });
};

interface VoiceSummaryHandlerDeps {
  relaySend: RelaySend;
  sessionManager: SessionManager;
  getProviderEnv: () => NodeJS.ProcessEnv;
  runner?: VoiceSummaryRunner;
}

export class VoiceSummaryHandler {
  private readonly cache = new Map<string, string>();
  private readonly runner: VoiceSummaryRunner;

  constructor(private readonly deps: VoiceSummaryHandlerDeps) {
    this.runner = deps.runner ?? runClaudeSpeechSummary;
  }

  async onVoiceSummaryRequest(msg: ControlMessage<"voice_summary_request">): Promise<void> {
    const session = this.deps.sessionManager.getSession(msg.sessionId);
    if (!session) {
      this.sendFailure(msg, "Session not found", ControlErrorCode.SESSION_NOT_FOUND);
      return;
    }

    const cacheKey = cacheKeyForSummary(msg.sessionId, msg.messageId, msg.reason, msg.text);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.sendSuccess(msg, cached);
      return;
    }

    const prompt = buildVoiceSummaryPrompt({ reason: msg.reason, text: msg.text });
    try {
      const summary = sanitizeSummary(
        await this.runner({
          cwd: session.cwd,
          prompt,
          env: this.deps.getProviderEnv(),
          timeoutMs: SUMMARY_TIMEOUT_MS,
        }),
      );
      if (!summary) {
        this.sendFailure(msg, "Voice summary is empty", ControlErrorCode.UNKNOWN);
        return;
      }
      this.cache.set(cacheKey, summary);
      this.sendSuccess(msg, summary);
    } catch (err) {
      serviceLogger.warn(
        { sessionId: msg.sessionId, messageId: msg.messageId, error: String(err) },
        "Voice summary generation failed",
      );
      this.sendFailure(msg, "Voice summary generation failed", ControlErrorCode.UNKNOWN);
    }
  }

  private sendSuccess(msg: ControlMessage<"voice_summary_request">, summary: string): void {
    this.deps.relaySend(
      serializeControl({
        type: "voice_summary_response",
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        messageId: msg.messageId,
        success: true,
        summary,
      }),
    );
  }

  private sendFailure(
    msg: ControlMessage<"voice_summary_request">,
    error: string,
    errorCode: ControlErrorCode,
  ): void {
    this.deps.relaySend(
      serializeControl({
        type: "voice_summary_response",
        requestId: msg.requestId,
        sessionId: msg.sessionId,
        messageId: msg.messageId,
        success: false,
        error,
        errorCode,
      }),
    );
  }
}

function cacheKeyForSummary(
  sessionId: string,
  messageId: string,
  reason: VoiceSummaryReason,
  text: string,
): string {
  return createHash("sha256")
    .update(sessionId)
    .update("\0")
    .update(messageId)
    .update("\0")
    .update(reason)
    .update("\0")
    .update(text)
    .digest("hex");
}

function sanitizeSummary(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 1_000);
}
