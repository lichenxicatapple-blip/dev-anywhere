import { describe, it, expect } from "vitest";
import { extractOscSignals } from "#src/osc-extractor.js";

describe("extractOscSignals", () => {
  it("returns turn_complete for OSC 9 'waiting for your input'", () => {
    // BEL 结尾
    const data = "\x1b]9;waiting for your input\x07";
    const result = extractOscSignals(data);
    expect(result).toEqual({ state: "turn_complete" });
  });

  it("returns approval_wait for OSC 9 'needs your permission'", () => {
    const data = "\x1b]9;needs your permission\x07";
    const result = extractOscSignals(data);
    expect(result).not.toBeNull();
    expect(result!.state).toBe("approval_wait");
  });

  it("extracts tool name from 'needs your permission: Bash'", () => {
    const data = "\x1b]9;needs your permission: Bash\x07";
    const result = extractOscSignals(data);
    expect(result).toEqual({ state: "approval_wait", tool: "Bash" });
  });

  it("returns mid_pause with title for OSC 0 only", () => {
    const data = "\x1b]0;claude - working...\x07";
    const result = extractOscSignals(data);
    expect(result).toEqual({ state: "mid_pause", title: "claude - working..." });
  });

  it("returns null when no OSC sequences present", () => {
    const data = "plain terminal output with no escapes";
    const result = extractOscSignals(data);
    expect(result).toBeNull();
  });

  it("prioritizes OSC 9 over OSC 0 when both present", () => {
    const data =
      "\x1b]0;some title\x07" +
      "some output" +
      "\x1b]9;waiting for your input\x07";
    const result = extractOscSignals(data);
    expect(result).toEqual({ state: "turn_complete" });
  });

  it("handles BEL terminator (\\x07)", () => {
    const data = "\x1b]9;waiting for your input\x07";
    const result = extractOscSignals(data);
    expect(result).not.toBeNull();
    expect(result!.state).toBe("turn_complete");
  });

  it("handles ST terminator (ESC \\\\)", () => {
    const data = "\x1b]9;waiting for your input\x1b\\";
    const result = extractOscSignals(data);
    expect(result).not.toBeNull();
    expect(result!.state).toBe("turn_complete");
  });

  it("parses correctly with embedded data around OSC sequences", () => {
    const data =
      "some terminal output before\x1b]9;needs your permission: Write\x07more output after";
    const result = extractOscSignals(data);
    expect(result).toEqual({ state: "approval_wait", tool: "Write" });
  });
});
