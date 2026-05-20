import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  JsonSession,
  ToolWhitelist,
  createRelayApprovalStrategy,
  type StreamJsonEvent,
} from "#src/worker/json-session.js";

const enabled = process.env.DEV_ANYWHERE_REAL_CLAUDE_CLI === "1";

function claudeAvailable(): boolean {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function collectToolNames(event: StreamJsonEvent): string[] {
  if (event.type !== "assistant") return [];
  const message = event.message;
  if (!message || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];

  return content
    .filter((block): block is { type: string; name?: unknown } => {
      return Boolean(
        block && typeof block === "object" && (block as { type?: unknown }).type === "tool_use",
      );
    })
    .map((block) => block.name)
    .filter((name): name is string => typeof name === "string");
}

describe.skipIf(!enabled || !claudeAvailable())("real Claude CLI session whitelist", () => {
  it("uses Always Allow behavior to auto-approve a later same-tool request", async () => {
    const cwd =
      process.env.DEV_ANYWHERE_REAL_PROVIDER_CWD ??
      mkdtempSync(join(tmpdir(), "dev-anywhere-real-claude-whitelist-"));
    const firstFile = join(cwd, "dev-anywhere-real-whitelist-1.txt");
    const secondFile = join(cwd, "dev-anywhere-real-whitelist-2.txt");
    const whitelist = new ToolWhitelist();
    const forwardedApprovals: Array<{ toolName: string; input: Record<string, unknown> }> = [];
    const assistantToolNames: string[] = [];
    const events: StreamJsonEvent[] = [];
    let session: JsonSession | undefined;
    let settled = false;

    const forwardToRelay = vi.fn(async (toolName: string, input: Record<string, unknown>) => {
      forwardedApprovals.push({ toolName, input });
      if (toolName === "Write") {
        whitelist.add(toolName);
      }
      return { behavior: "allow" as const, message: "allowed once and added to session whitelist" };
    });

    const finished = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            [
              "Timed out waiting for real Claude CLI whitelist smoke to finish.",
              `Forwarded approvals: ${JSON.stringify(forwardedApprovals)}`,
              `Assistant tools: ${JSON.stringify(assistantToolNames)}`,
              `Last events: ${JSON.stringify(events.slice(-5))}`,
              `Stderr: ${session?.getStderr() ?? ""}`,
            ].join("\n"),
          ),
        );
      }, 180_000);

      session = new JsonSession({
        cwd,
        permissionMode: "default",
        approvalStrategy: createRelayApprovalStrategy(whitelist, forwardToRelay),
        onEvent: (event) => {
          events.push(event);
          assistantToolNames.push(...collectToolNames(event));
          if (event.type === "result" && !settled) {
            settled = true;
            clearTimeout(timeout);
            resolve();
          }
        },
        onExit: (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(
            new Error(
              `real Claude CLI exited before result event: code=${code}\n${session?.getStderr() ?? ""}`,
            ),
          );
        },
      });

      session.start();
      session.sendMessage(
        [
          "This is an automated dev-anywhere approval smoke test.",
          "Use the Write tool exactly twice, in two separate tool calls.",
          `First Write tool call: create ${firstFile} with exactly this content: DA_REAL_WHITELIST_1`,
          `Second Write tool call: create ${secondFile} with exactly this content: DA_REAL_WHITELIST_2`,
          "Do not use any other tools.",
          "After both Write calls finish, reply exactly: DA_REAL_WHITELIST_DONE",
        ].join("\n"),
      );
    });

    try {
      await finished;

      const writeToolUses = assistantToolNames.filter((name) => name === "Write");
      expect(writeToolUses.length).toBeGreaterThanOrEqual(2);
      expect(forwardToRelay).toHaveBeenCalledTimes(1);
      expect(forwardedApprovals).toHaveLength(1);
      expect(forwardedApprovals[0]?.toolName).toBe("Write");
      expect(existsSync(firstFile)).toBe(true);
      expect(existsSync(secondFile)).toBe(true);
      expect(readFileSync(firstFile, "utf8")).toContain("DA_REAL_WHITELIST_1");
      expect(readFileSync(secondFile, "utf8")).toContain("DA_REAL_WHITELIST_2");
    } finally {
      await session?.stop(1000).catch(() => undefined);
      if (!process.env.DEV_ANYWHERE_REAL_PROVIDER_CWD) {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  }, 190_000);
});
