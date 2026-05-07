import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@dev-anywhere/shared";
import { sessionTerminationCopy } from "./session-termination-dialog";

const baseSession: SessionInfo = {
  sessionId: "s1",
  mode: "pty",
  provider: "claude",
  state: "idle",
};

describe("sessionTerminationCopy", () => {
  it("uses detach wording for local-terminal PTY sessions", () => {
    expect(
      sessionTerminationCopy({
        ...baseSession,
        ptyOwner: "local-terminal",
      }),
    ).toEqual({
      title: "断开远程连接？",
      description:
        "这只会把当前会话从 Web 中移除，本地终端里的 Claude/Codex 会继续运行。断开后，Web 将无法继续查看或输入这个会话。",
      confirmLabel: "断开远程连接",
      destructive: false,
    });
  });

  it("uses destructive termination wording for hosted PTY and JSON sessions", () => {
    expect(
      sessionTerminationCopy({
        ...baseSession,
        ptyOwner: "proxy-hosted",
      }),
    ).toMatchObject({
      title: "终止会话？",
      confirmLabel: "终止会话",
      destructive: true,
    });
    expect(sessionTerminationCopy({ ...baseSession, mode: "json" })).toMatchObject({
      title: "终止会话？",
      confirmLabel: "终止会话",
      destructive: true,
    });
  });
});
