import { afterEach, describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { MarkdownView } from "./markdown-view";

const originalMatchMedia = window.matchMedia;

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

function mockCoarsePointer(matches: boolean): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

describe("MarkdownView XSS 防护", () => {
  it("drops script tags", () => {
    // 使用段落分隔保证 hello 是独立文本节点, 而非内联在 raw HTML 块里被 skipHtml 一并丢弃
    const { container } = render(<MarkdownView text={"<script>alert(1)</script>\n\nhello"} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("hello");
  });

  it("drops iframe tags", () => {
    const { container } = render(<MarkdownView text={'<iframe src="evil"></iframe>text'} />);
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("drops object and embed", () => {
    const { container } = render(<MarkdownView text={"<object></object><embed></embed>text"} />);
    expect(container.querySelector("object")).toBeNull();
    expect(container.querySelector("embed")).toBeNull();
  });

  it("renders fenced code block", () => {
    const { container } = render(<MarkdownView text={"```ts\nconst x = 1;\n```"} />);
    expect(container.querySelector("pre")).not.toBeNull();
  });

  it("wraps unlabelled fenced code block in an overflow container", () => {
    const { container } = render(
      <MarkdownView text={"```\ndata/pipeline/sticker/sticker_cluster.py:172\n```"} />,
    );
    const code = container.querySelector("pre code");
    expect(code?.textContent).toContain("sticker_cluster.py");
    expect(code?.closest('[data-slot="markdown-code-block"]')?.className).toContain(
      "overflow-x-auto",
    );
  });

  it("allows long inline code to break inside chat bubbles", () => {
    const { container } = render(
      <MarkdownView text={"`data/pipeline/sticker/sticker_cluster.py:172`"} />,
    );
    const code = container.querySelector("code");
    expect(code?.className).toContain("break-all");
    expect(code?.className).toContain("whitespace-normal");
  });

  it("renders external links with target=_blank + rel noopener", () => {
    const { container } = render(<MarkdownView text={"[click](https://example.com)"} />);
    const link = container.querySelector("a");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toContain("noopener");
  });

  it("opens external links on desktop only with cmd/ctrl click", () => {
    mockCoarsePointer(false);
    const { container } = render(<MarkdownView text={"[click](https://example.com)"} />);
    const link = container.querySelector("a");
    expect(link).not.toBeNull();

    const plainClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    expect(link?.dispatchEvent(plainClick)).toBe(false);
    expect(plainClick.defaultPrevented).toBe(true);

    const modifiedClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    expect(link?.dispatchEvent(modifiedClick)).toBe(true);
    expect(modifiedClick.defaultPrevented).toBe(false);
  });

  it("opens external links on mobile tap without modifiers", () => {
    mockCoarsePointer(true);
    const { container } = render(<MarkdownView text={"[click](https://example.com)"} />);
    const link = container.querySelector("a");
    const plainTap = new MouseEvent("click", { bubbles: true, cancelable: true });
    expect(link?.dispatchEvent(plainTap)).toBe(true);
    expect(plainTap.defaultPrevented).toBe(false);
  });

  // GFM 表格在超出 bubble 宽度时需横向滚动, 关键是 <table> 外必须有 overflow-x 容器
  // 否则长表格 (如语言对比表) 会被 max-w-[80%] bubble 挤压换行
  it("wraps GFM table in overflow-x container", () => {
    const md = "| A | B |\n| - | - |\n| 1 | 2 |";
    const { container } = render(<MarkdownView text={md} />);
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(table?.parentElement?.className).toContain("overflow-x-auto");
  });
});
