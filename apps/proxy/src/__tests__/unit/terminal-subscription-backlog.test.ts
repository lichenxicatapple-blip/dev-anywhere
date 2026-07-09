import { describe, expect, it } from "vitest";
import { TerminalSubscriptionBacklog } from "#src/serve/terminal-subscription-backlog.js";

describe("TerminalSubscriptionBacklog", () => {
  it("keeps pending PTY subscribe requests until the terminal registers", () => {
    const backlog = new TerminalSubscriptionBacklog();
    backlog.add("s1", "req-1");
    backlog.add("s1", "req-2");

    expect(backlog.take("s1")).toEqual([{ requestId: "req-1" }, { requestId: "req-2" }]);
    expect(backlog.take("s1")).toEqual([]);
  });

  it("dedupes repeated request ids and caps retained requests per session", () => {
    const backlog = new TerminalSubscriptionBacklog();
    backlog.add("s1", "req-1");
    backlog.add("s1", "req-1");
    for (let i = 2; i <= 10; i += 1) {
      backlog.add("s1", `req-${i}`);
    }

    expect(backlog.take("s1")).toEqual([
      { requestId: "req-3" },
      { requestId: "req-4" },
      { requestId: "req-5" },
      { requestId: "req-6" },
      { requestId: "req-7" },
      { requestId: "req-8" },
      { requestId: "req-9" },
      { requestId: "req-10" },
    ]);
  });
});
