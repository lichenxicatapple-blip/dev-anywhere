import { describe, it, expect } from "vitest";
import { PROXY_TO_CLIENT_TYPES } from "#src/handlers/proxy.js";

/**
 * 防护测试：确保 proxy 发往 relay 的所有 control 消息类型都在透传列表中
 *
 * serve.ts / control-messages.ts 每新增一个发往 relay 的消息类型，
 * 都必须加到 PROXY_TO_CLIENT_TYPES，否则 relay 会静默丢弃。
 * 如果你在这里看到失败，说明 proxy 侧新增了消息类型但忘了更新 relay 透传列表。
 */
describe("PROXY_TO_CLIENT_TYPES completeness", () => {
  // proxy 侧所有通过 relayConnection.sendRaw 发出的 control 消息类型
  const EXPECTED_TYPES = [
    "terminal_frame",
    "terminal_title",
    "terminal_resize",
    "dir_list_response",
    "command_list_push",
    "file_tree_push",
    "session_history_response",
    "pty_state",
    "session_list",
  ];

  it.each(EXPECTED_TYPES)("includes '%s'", (type) => {
    expect(PROXY_TO_CLIENT_TYPES.has(type)).toBe(true);
  });

  it("has no unexpected extra types", () => {
    // 如果 relay 侧多了 proxy 没发的类型，可能是死代码
    for (const type of PROXY_TO_CLIENT_TYPES) {
      expect(EXPECTED_TYPES).toContain(type);
    }
  });
});
