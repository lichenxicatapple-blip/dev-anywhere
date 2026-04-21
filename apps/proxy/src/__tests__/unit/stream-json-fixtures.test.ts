import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamJsonEventSchema, KnownContentBlockSchema } from "#src/common/stream-json-schema.js";

// Claude CLI schema drift canary: 每当 CLI 升级后重采 fixture 跑这批测试
// fixture 目录按 CLI 版本分目录存，测试覆盖最新版本目录下的全部 scenario
const FIXTURES_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/stream-json");

// 我们主动忽略的 event type（非 assistant/user/result 的事件，不走 forwardEvent 业务分支）
const IGNORED_EVENT_TYPES = new Set(["system", "rate_limit_event", "stream_event"]);

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
  const scenarios = ["text-only", "tool-use", "thinking", "thinking-plain"];

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
});
