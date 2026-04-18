import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MarkdownView } from "./markdown-view";

describe("MarkdownView XSS 防护", () => {
  it("drops script tags", () => {
    // 使用段落分隔保证 hello 是独立文本节点, 而非内联在 raw HTML 块里被 skipHtml 一并丢弃
    const { container } = render(
      <MarkdownView text={"<script>alert(1)</script>\n\nhello"} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("hello");
  });

  it("drops iframe tags", () => {
    const { container } = render(
      <MarkdownView text={'<iframe src="evil"></iframe>text'} />,
    );
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("drops object and embed", () => {
    const { container } = render(
      <MarkdownView text={"<object></object><embed></embed>text"} />,
    );
    expect(container.querySelector("object")).toBeNull();
    expect(container.querySelector("embed")).toBeNull();
  });

  it("renders fenced code block", () => {
    const { container } = render(
      <MarkdownView text={"```ts\nconst x = 1;\n```"} />,
    );
    expect(container.querySelector("pre")).not.toBeNull();
  });

  it("renders external links with target=_blank + rel noopener", () => {
    const { container } = render(
      <MarkdownView text={"[click](https://example.com)"} />,
    );
    const link = container.querySelector("a");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noopener");
  });
});
