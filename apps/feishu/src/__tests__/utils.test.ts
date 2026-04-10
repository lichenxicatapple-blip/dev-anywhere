import { describe, it, expect, vi, afterEach } from "vitest";
import { formatRelativeTime } from "@/utils/relative-time";
import { truncateText, generateSessionTitle } from "@/utils/text-truncate";

describe("formatRelativeTime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 'just now' for < 60s", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000 * 30 + 1000);
    expect(formatRelativeTime(1000)).toBe("just now");
  });

  it("returns 'N min ago' for < 60min", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000 * 60 * 5 + 1000);
    expect(formatRelativeTime(1000)).toBe("5 min ago");
  });

  it("returns 'N hr ago' for < 24hr", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000 * 3600 * 3 + 1000);
    expect(formatRelativeTime(1000)).toBe("3 hr ago");
  });

  it("returns 'N days ago' for >= 24hr", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000 * 86400 * 2 + 1000);
    expect(formatRelativeTime(1000)).toBe("2 days ago");
  });
});

describe("truncateText", () => {
  it("returns full text if shorter than maxLength", () => {
    expect(truncateText("hello", 20)).toBe("hello");
  });

  it("truncates and adds ellipsis for long text", () => {
    const text = "this is a very long text that should be truncated";
    expect(truncateText(text, 20)).toBe("this is a very long ...");
  });

  it("returns exact text when length equals maxLength", () => {
    expect(truncateText("12345", 5)).toBe("12345");
  });
});

describe("generateSessionTitle", () => {
  it("returns 'New Session' when no message", () => {
    expect(generateSessionTitle(undefined)).toBe("New Session");
  });

  it("truncates first user message to 20 chars", () => {
    const msg = "Fix the WebSocket reconnection bug in relay server";
    expect(generateSessionTitle(msg)).toBe("Fix the WebSocket re...");
  });

  it("returns full message if short enough", () => {
    expect(generateSessionTitle("Short msg")).toBe("Short msg");
  });
});
