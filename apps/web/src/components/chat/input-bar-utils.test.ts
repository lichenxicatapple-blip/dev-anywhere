import { describe, expect, it } from "vitest";
import { composeInputWithAttachments } from "./input-bar-utils";

describe("composeInputWithAttachments", () => {
  it("preserves the existing agent path-token payload without exposing it in the draft", () => {
    expect(
      composeInputWithAttachments("inspect this image ", [
        { path: ".dev-anywhere/clipboard/s1/shot.png" },
        { path: ".dev-anywhere/uploads/s1/notes.txt" },
      ]),
    ).toBe(
      "inspect this image @.dev-anywhere/clipboard/s1/shot.png @.dev-anywhere/uploads/s1/notes.txt",
    );
  });

  it("allows an attachment-only message", () => {
    expect(composeInputWithAttachments("", [{ path: ".dev-anywhere/uploads/s1/notes.txt" }])).toBe(
      "@.dev-anywhere/uploads/s1/notes.txt",
    );
  });
});
