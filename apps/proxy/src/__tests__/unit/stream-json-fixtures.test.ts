import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ContentBlockDeltaSchema,
  ControlRequestEventSchema,
  ControlResponseEventSchema,
  IGNORED_EVENT_TYPES,
  StreamJsonEventSchema,
  KnownContentBlockSchema,
} from "#src/common/stream-json-schema.js";

// Claude CLI schema drift canary: 每当 CLI 升级后重采 fixture 跑这批测试
// fixture 目录按 CLI 版本分目录存，测试覆盖最新版本目录下的全部 scenario
const FIXTURES_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/stream-json");

function listVersions(): string[] {
  return readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("claude-"))
    .map((d) => d.name);
}

function readFixture(version: string, scenario: string): unknown[] {
  const path = join(FIXTURES_ROOT, version, `${scenario}.jsonl`);
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

const versions = listVersions();
if (versions.length === 0) {
  throw new Error(`No fixture versions found under ${FIXTURES_ROOT}`);
}

describe.each(versions)("stream-json fixtures (%s)", (version) => {
  const scenarios = [
    "text-only",
    "tool-use",
    "thinking",
    "thinking-plain",
    "stream-delta",
    "control-request",
  ];

  it.each(scenarios)("%s: every event is known or intentionally ignored", (scenario) => {
    const events = readFixture(version, scenario);
    for (const ev of events) {
      const rawType =
        ev && typeof ev === "object" ? ((ev as { type?: unknown }).type as string) : "<missing>";
      const parsed = StreamJsonEventSchema.safeParse(ev);
      if (!parsed.success) {
        expect(
          IGNORED_EVENT_TYPES.has(rawType),
          `unknown event type ${rawType} in ${scenario}; update schema or ignored list`,
        ).toBe(true);
      }
    }
  });

  it.each(scenarios)("%s: every assistant/user content block is recognized", (scenario) => {
    const events = readFixture(version, scenario);
    for (const ev of events) {
      if (!ev || typeof ev !== "object") continue;
      const typed = ev as { type?: string; message?: { content?: unknown[] } };
      if (typed.type !== "assistant" && typed.type !== "user") continue;
      const content = typed.message?.content ?? [];
      for (const block of content) {
        const parsed = KnownContentBlockSchema.safeParse(block);
        const blockType =
          block && typeof block === "object" ? (block as { type?: string }).type : "<missing>";
        expect(
          parsed.success,
          `unrecognized block type ${blockType} in ${scenario}; update KnownContentBlockSchema`,
        ).toBe(true);
      }
    }
  });

  it("tool-use scenario contains tool_use + tool_result blocks", () => {
    const events = readFixture(version, "tool-use");
    const blockTypes = new Set<string>();
    for (const ev of events) {
      if (!ev || typeof ev !== "object") continue;
      const typed = ev as { type?: string; message?: { content?: unknown[] } };
      if (typed.type !== "assistant" && typed.type !== "user") continue;
      for (const block of typed.message?.content ?? []) {
        if (block && typeof block === "object") {
          const t = (block as { type?: string }).type;
          if (t) blockTypes.add(t);
        }
      }
    }
    expect(blockTypes.has("tool_use")).toBe(true);
    expect(blockTypes.has("tool_result")).toBe(true);
  });

  it("thinking scenario (Opus) has thinking block with empty plain text (redacted)", () => {
    const events = readFixture(version, "thinking");
    const thinkingBlocks: Array<{ thinking?: string; signature?: string }> = [];
    for (const ev of events) {
      if (!ev || typeof ev !== "object") continue;
      const typed = ev as { type?: string; message?: { content?: unknown[] } };
      if (typed.type !== "assistant") continue;
      for (const block of typed.message?.content ?? []) {
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: string }).type === "thinking"
        ) {
          thinkingBlocks.push(block as { thinking?: string; signature?: string });
        }
      }
    }
    expect(thinkingBlocks.length).toBeGreaterThan(0);
    // Opus 的 thinking 明文被 Anthropic 服务端 redact，只给 signature
    const redacted = thinkingBlocks.filter(
      (b) => b.thinking === "" && (b.signature ?? "").length > 0,
    );
    expect(redacted.length).toBeGreaterThan(0);
  });

  it("thinking-plain scenario (Haiku) exposes thinking plain text", () => {
    const events = readFixture(version, "thinking-plain");
    const thinkingTexts: string[] = [];
    for (const ev of events) {
      if (!ev || typeof ev !== "object") continue;
      const typed = ev as { type?: string; message?: { content?: unknown[] } };
      if (typed.type !== "assistant") continue;
      for (const block of typed.message?.content ?? []) {
        if (
          block &&
          typeof block === "object" &&
          (block as { type?: string }).type === "thinking"
        ) {
          const text = (block as { thinking?: string }).thinking ?? "";
          if (text) thinkingTexts.push(text);
        }
      }
    }
    expect(thinkingTexts.length).toBeGreaterThan(0);
  });

  it("every scenario terminates with a result event", () => {
    for (const scenario of scenarios) {
      const events = readFixture(version, scenario);
      const last = events[events.length - 1];
      expect((last as { type?: string }).type, `${scenario} must end with result event`).toBe(
        "result",
      );
    }
  });

  it("text-only scenario produces text block", () => {
    const events = readFixture(version, "text-only");
    const hasText = events.some((ev) => {
      if (!ev || typeof ev !== "object") return false;
      const typed = ev as { type?: string; message?: { content?: unknown[] } };
      if (typed.type !== "assistant") return false;
      return (typed.message?.content ?? []).some(
        (b) => b && typeof b === "object" && (b as { type?: string }).type === "text",
      );
    });
    expect(hasText).toBe(true);
  });

  it("stream-delta scenario contains stream_event wrapped content_block_delta", () => {
    const events = readFixture(version, "stream-delta");
    const streamEvents = events.filter(
      (ev) => ev && typeof ev === "object" && (ev as { type?: string }).type === "stream_event",
    );
    expect(streamEvents.length).toBeGreaterThan(0);

    // 至少一个 stream_event 的 inner event 是 content_block_delta 且 schema parse 成功
    const deltas = streamEvents
      .map((se) => (se as { event?: unknown }).event)
      .map((inner) => ContentBlockDeltaSchema.safeParse(inner))
      .filter((r) => r.success);
    expect(deltas.length).toBeGreaterThan(0);

    // 验证 delta 字段形状：content_block_delta.delta 覆盖已知三种类型
    const deltaTypes = new Set<string>();
    for (const r of deltas) {
      if (r.success) deltaTypes.add(r.data.delta.type);
    }
    // text_delta 和 thinking_delta 来自正常增量，是 proxy 消费目标
    expect(deltaTypes.has("text_delta")).toBe(true);
    expect(deltaTypes.has("thinking_delta")).toBe(true);
  });

  it("control-request scenario contains a parseable request + response pair", () => {
    const events = readFixture(version, "control-request");
    const requests = events.filter(
      (ev) => ev && typeof ev === "object" && (ev as { type?: string }).type === "control_request",
    );
    const responses = events.filter(
      (ev) => ev && typeof ev === "object" && (ev as { type?: string }).type === "control_response",
    );
    expect(requests.length).toBeGreaterThan(0);
    expect(responses.length).toBe(requests.length);

    // 所有 control_request 都能被 schema parse，tool_name + input 两个必需字段完整
    for (const req of requests) {
      const parsed = ControlRequestEventSchema.safeParse(req);
      expect(
        parsed.success,
        `control_request parse failed: ${JSON.stringify(req).slice(0, 200)}`,
      ).toBe(true);
      if (parsed.success) {
        expect(parsed.data.request.tool_name.length).toBeGreaterThan(0);
      }
    }

    // 响应 shape 也 round-trip 可解，保证 handleControlRequest 写回的 JSON 合法
    for (const resp of responses) {
      const parsed = ControlResponseEventSchema.safeParse(resp);
      expect(parsed.success).toBe(true);
    }

    // request_id 必须一一对应，否则 claude 会永远阻塞在审批上
    const reqIds = new Set(
      requests.map((r) => ControlRequestEventSchema.parse(r as Record<string, unknown>).request_id),
    );
    const respIds = new Set(
      responses.map(
        (r) => ControlResponseEventSchema.parse(r as Record<string, unknown>).response.request_id,
      ),
    );
    expect(reqIds).toEqual(respIds);
  });
});
