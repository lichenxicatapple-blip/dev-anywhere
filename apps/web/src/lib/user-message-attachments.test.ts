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

  it.each(["mp4", "webm", "mov", "m4v", "ogv"])(
    "extracts uploaded %s videos while preserving paths containing spaces",
    (extension) => {
      const path = `/private/uploads/demo clips/final cut.${extension}`;
      expect(extractUserMessageAttachments(`看看这个 @${path}`)).toEqual({
        bodyText: "看看这个",
        attachments: [{ kind: "video", path }],
      });
    },
  );

  it("keeps the ordering of mixed image, video, and file attachment suffixes", () => {
    expect(
      extractUserMessageAttachments("@uploads/still.png @uploads/demo.MP4 @uploads/report.pdf"),
    ).toEqual({
      bodyText: "",
      attachments: [
        { kind: "image", path: "uploads/still.png" },
        { kind: "video", path: "uploads/demo.MP4" },
        { kind: "file", path: "uploads/report.pdf" },
      ],
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
