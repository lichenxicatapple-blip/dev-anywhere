import { describe, expect, it } from "vitest";
import { isCompactCommandText } from "../slash-commands.js";

describe("slash command helpers", () => {
  it.each(["/compact", " /compact", "/compact now", "\t/compact\n"])(
    "recognizes %s as a compact command",
    (text) => {
      expect(isCompactCommandText(text)).toBe(true);
    },
  );

  it.each(["compact", "/compactly", "/compact-now", "please /compact"])(
    "does not treat %s as a compact command",
    (text) => {
      expect(isCompactCommandText(text)).toBe(false);
    },
  );
});
