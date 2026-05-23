// 真 backend 业务 e2e (protocol-level, 不经 web UI):
// hostedPty fixture 起真 claude PTY → ClientWs 收 binary frame, 验真 claude banner.
//
// jsonMode fixture 会触发真 Claude API 调用。它覆盖的是外部供应商可用性 + stream-json
// 端到端链路，不属于默认 PC/release smoke 的确定性门禁；需要时显式设置
// DEV_ANYWHERE_REAL_JSON_BACKEND_SMOKE=1 运行。
//
// 缺真 claude CLI 时 fixture 自动 skip; 单独的"真 backend 协议契约"扩展, 不重复 fixtures-contract.
import { expect, test } from "../fixtures/sessions";

const runRealJsonBackendSmoke = process.env.DEV_ANYWHERE_REAL_JSON_BACKEND_SMOKE === "1";

test.describe("real backend session protocol-level e2e", () => {
  test.setTimeout(90_000);

  test("hostedPty: subscribing yields PTY frames containing claude banner", async ({
    hostedPty,
  }) => {
    let collected = "";
    const dispose = hostedPty.onBinary((buf) => {
      const view = new Uint8Array(buf);
      const sidLen = view[0]!;
      const sid = new TextDecoder().decode(view.slice(1, 1 + sidLen));
      if (sid !== hostedPty.sessionId) return;
      const payload = new TextDecoder().decode(view.slice(1 + sidLen + 4));
      collected += payload;
    });

    hostedPty.send({
      type: "session_subscribe",
      sessionId: hostedPty.sessionId,
      requestId: "real-pty-sub",
    });

    // claude banner 启动后会输出至少含 "Welcome" / "claude" / "Code" 之一. 实际 claude
    // 启动 banner 大致 8-15s, 给 60s 容忍 cold start.
    await expect
      .poll(() => collected, { timeout: 60_000, intervals: [200, 500, 1_000] })
      .toMatch(/Welcome|claude|Code/i);

    dispose();
  });

  test.describe("real Claude JSON backend", () => {
    test.skip(
      !runRealJsonBackendSmoke,
      "set DEV_ANYWHERE_REAL_JSON_BACKEND_SMOKE=1 to call the real Claude API",
    );
    test.setTimeout(120_000);

    test("jsonMode: send user_input gets assistant_message back via stream-json", async ({
      jsonMode,
    }) => {
      let assistantText = "";
      let sawStatus = false;
      const dispose = jsonMode.onJson((msg) => {
        if (msg.sessionId !== jsonMode.sessionId) return;
        if (msg.type === "session_status") sawStatus = true;
        if (msg.type === "assistant_message") {
          const payload = msg.payload as { text?: string } | undefined;
          if (payload?.text) assistantText += payload.text;
        }
      });

      jsonMode.send({
        type: "session_subscribe",
        sessionId: jsonMode.sessionId,
        requestId: "real-json-sub",
      });

      // user_input 是 Envelope, 必须带 BaseEnvelopeFields (seq/timestamp/source/version),
      // 否则 proxy 端 MessageEnvelopeSchema.parse 失败 silently drop.
      jsonMode.send({
        type: "user_input",
        sessionId: jsonMode.sessionId,
        seq: Date.now(),
        timestamp: Date.now(),
        source: "client",
        version: "1",
        payload: {
          text: "Reply with just the single word: pong",
          messageId: `${jsonMode.sessionId}-real-input`,
        },
      });

      // 真 claude stream-json 从 user_input 到第一 token 大致 5-15s. 给 60s.
      await expect
        .poll(() => assistantText.length, { timeout: 60_000, intervals: [500, 1_000] })
        .toBeGreaterThan(0);
      expect(sawStatus).toBe(true);

      dispose();
    });
  });
});
