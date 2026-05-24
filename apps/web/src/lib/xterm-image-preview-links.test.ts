import { describe, expect, it, vi } from "vitest";
import {
  findImagePreviewPathMatches,
  registerImagePreviewLinkProvider,
} from "./xterm-image-preview-links";

describe("xterm image preview links", () => {
  it("finds image path ranges with 1-based terminal columns", () => {
    expect(findImagePreviewPathMatches("open @.dev-anywhere/clipboard/s1/shot.png now")).toEqual([
      {
        path: ".dev-anywhere/clipboard/s1/shot.png",
        startColumn: 6,
        endColumn: 41,
      },
    ]);
  });

  it("uses terminal display columns when wide CJK characters precede the path", () => {
    expect(
      findImagePreviewPathMatches("可测路径，应该能直接点击： .dev-anywhere/preview-demo.png。"),
    ).toEqual([
      {
        path: ".dev-anywhere/preview-demo.png",
        startColumn: 28,
        endColumn: 57,
      },
    ]);
  });

  it("keeps a leading @ inside the terminal link range after CJK text", () => {
    expect(findImagePreviewPathMatches("截图：@.dev-anywhere/clipboard/s1/shot.png")).toEqual([
      {
        path: ".dev-anywhere/clipboard/s1/shot.png",
        startColumn: 7,
        endColumn: 42,
      },
    ]);
  });

  function provideAndActivate(
    onPreview: (path: string) => void,
    event: { metaKey?: boolean; ctrlKey?: boolean; pointerType?: string } & Partial<
      Pick<MouseEvent, "type">
    > = {},
  ): { text?: string } {
    const providerRef: {
      current?: { provideLinks: (line: number, cb: (links: unknown) => void) => void };
    } = {};
    const term = {
      buffer: {
        active: {
          getLine: () => ({
            translateToString: () => "artifact /tmp/shot.png",
          }),
        },
      },
      registerLinkProvider: vi.fn((provider) => {
        providerRef.current = provider;
        return { dispose: vi.fn() };
      }),
    };
    registerImagePreviewLinkProvider(term as never, onPreview);

    const captured: { text?: string } = {};
    providerRef.current?.provideLinks(1, (links) => {
      const [link] = links as Array<{
        text: string;
        activate: (event: MouseEvent, text: string) => void;
      }>;
      captured.text = link.text;
      link.activate(event as MouseEvent, link.text);
    });
    return captured;
  }

  // 单击太容易误触, cmd/ctrl+click 才触发预览。
  it("only triggers image preview when the user holds cmd or ctrl on click", () => {
    const onPreview = vi.fn();
    const captured = provideAndActivate(onPreview, { metaKey: true });
    expect(captured.text).toBe("/tmp/shot.png");
    expect(onPreview).toHaveBeenCalledWith("/tmp/shot.png");
  });

  it("also triggers on ctrl+click for non-mac users", () => {
    const onPreview = vi.fn();
    provideAndActivate(onPreview, { ctrlKey: true });
    expect(onPreview).toHaveBeenCalledWith("/tmp/shot.png");
  });

  it("ignores plain clicks without a modifier (anti-misclick)", () => {
    const onPreview = vi.fn();
    provideAndActivate(onPreview, {});
    expect(onPreview).not.toHaveBeenCalled();
  });

  // 触屏设备 (pointer: coarse) 没修饰键, plain tap 即触发. 平板接外置键盘走修饰键
  // 路径也照样 work (两条路径并存).
  describe("touch surface (mobile / tablet without keyboard)", () => {
    function withTouchSurface<T>(fn: () => T): T {
      const spy = vi.spyOn(window, "matchMedia").mockImplementation(
        (query: string) =>
          ({
            matches: query.includes("pointer: coarse") || query.includes("hover: none"),
            media: query,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false,
          }) as unknown as MediaQueryList,
      );
      try {
        return fn();
      } finally {
        spy.mockRestore();
      }
    }

    it("triggers preview on plain tap (no modifier needed)", () => {
      withTouchSurface(() => {
        const onPreview = vi.fn();
        provideAndActivate(onPreview, {});
        expect(onPreview).toHaveBeenCalledWith("/tmp/shot.png");
      });
    });

    it("triggers preview on touch pointer events even without media-query support", () => {
      const onPreview = vi.fn();
      provideAndActivate(onPreview, { pointerType: "touch" });
      expect(onPreview).toHaveBeenCalledWith("/tmp/shot.png");
    });

    it("still triggers on cmd+click when tablet has keyboard attached", () => {
      withTouchSurface(() => {
        const onPreview = vi.fn();
        provideAndActivate(onPreview, { metaKey: true });
        expect(onPreview).toHaveBeenCalledWith("/tmp/shot.png");
      });
    });
  });
});
