import { describe, expect, it } from "vitest";
import { prepareSpeechText } from "./speech-text";

describe("prepareSpeechText", () => {
  it("keeps Markdown link labels without speaking destinations", () => {
    expect(
      prepareSpeechText(
        "来源：[国务院办公厅关于 2026 年部分节假日安排的通知](https://www.gov.cn/zhengce/content/2025-11/04/content_7047098.htm)",
      ),
    ).toBe("来源：国务院办公厅关于 2026 年部分节假日安排的通知");
  });

  it("handles destinations containing balanced parentheses", () => {
    expect(prepareSpeechText("查看 [说明](https://example.com/a_(b)?x=1) 了解详情。")).toBe(
      "查看 说明 了解详情。",
    );
  });

  it("replaces bare URLs and autolinks with a spoken link marker", () => {
    expect(prepareSpeechText("来源：https://example.com/a?x=1。备用：<https://example.org/b>")).toBe(
      "来源：链接。备用：链接",
    );
  });

  it("keeps image descriptions without speaking image URLs", () => {
    expect(prepareSpeechText("结果如下：![构建结果](https://example.com/result.png)")).toBe(
      "结果如下：图片：构建结果",
    );
    expect(prepareSpeechText("结果如下：![](https://example.com/result.png)")).toBe(
      "结果如下：图片",
    );
  });

  it("removes reference definitions and presentation-only Markdown", () => {
    expect(
      prepareSpeechText(
        "## 结果\n\n**已经完成**，请运行 `pnpm test`。\n\n[详情]: https://example.com/report",
      ),
    ).toBe("结果，已经完成，请运行 pnpm test。");
  });

  it("leaves ordinary prose unchanged", () => {
    expect(prepareSpeechText("可以，我来处理。")).toBe("可以，我来处理。");
  });
});
