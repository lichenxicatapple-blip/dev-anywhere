import { describe, expect, it } from "vitest";
import { extractUserMessageAttachments } from "./user-message-attachments";

describe("extractUserMessageAttachments", () => {
  it("extracts consecutive uploaded image and file mentions from the message suffix", () => {
    expect(
      extractUserMessageAttachments(
        "帮我看看 @/Users/cat/My Project/first shot.png @custom-cache/uploads/report final.pdf",
      ),
    ).toEqual({
      bodyText: "帮我看看",
      attachments: [
        { kind: "image", path: "/Users/cat/My Project/first shot.png" },
        { kind: "file", path: "custom-cache/uploads/report final.pdf" },
      ],
    });
  });

  it("supports attachment-only messages without relying on an internal directory name", () => {
    expect(extractUserMessageAttachments("@arbitrary-root/session/photo.webp")).toEqual({
      bodyText: "",
      attachments: [{ kind: "image", path: "arbitrary-root/session/photo.webp" }],
    });
  });

  it("keeps paths discussed inside the message body as inline content", () => {
    expect(extractUserMessageAttachments("对比 @docs/old.json 的结构，然后修改这里")).toEqual({
      bodyText: "对比 @docs/old.json 的结构，然后修改这里",
      attachments: [],
    });
  });

  it("only collapses the contiguous explicit suffix", () => {
    expect(
      extractUserMessageAttachments("参考 @docs/input.json 后处理 @uploads/output.csv"),
    ).toEqual({
      bodyText: "参考 @docs/input.json 后处理",
      attachments: [{ kind: "file", path: "uploads/output.csv" }],
    });
  });
});
