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
        "这只会断开当前页面和本地终端的连接，本地终端里的 Claude/Codex 会继续运行。重新接入前，页面不能继续查看或输入这个会话。",
      confirmLabel: "断开远程连接",
      destructive: false,
    });
  });

  it("uses terminal wording for pure terminal sessions", () => {
    expect(
      sessionTerminationCopy({
        ...baseSession,
        kind: "terminal",
        ptyOwner: "proxy-hosted",
      }),
    ).toEqual({
      title: "终止终端？",
      description:
        "这会停止当前终端进程，并清理这个终端会话的运行状态。终止后不能继续输入，也无法恢复正在执行的命令。",
      confirmLabel: "终止终端",
      destructive: true,
    });
  });

  it("uses destructive agent termination wording for hosted PTY and JSON sessions", () => {
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
