import { describe, expect, it, vi } from "vitest";
import {
  findFileDownloadPathMatches,
  registerFileDownloadLinkProvider,
} from "./xterm-file-download-links";

describe("xterm file download links", () => {
  it("finds file path ranges with 1-based terminal columns", () => {
    expect(findFileDownloadPathMatches("see @./notes/log.txt please")).toEqual([
      {
        path: "./notes/log.txt",
        startColumn: 5,
        endColumn: 20,
      },
    ]);
  });

  it("uses terminal display columns when wide CJK characters precede the path", () => {
    // CJK 一字两列, 列号必须按 cell 算, 不能按 string index。
    const matches = findFileDownloadPathMatches("文件：@./notes/log.txt");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.path).toBe("./notes/log.txt");
    // "文件：" 占 6 列 + "@" 第 7 列, link range 起始 1-based = 7
    expect(matches[0]?.startColumn).toBe(7);
  });

  function provideAndActivate(
    onDownload: (path: string) => void,
    event: { metaKey?: boolean; ctrlKey?: boolean } = {},
    line = "artifact @./build/out.tar.gz done",
  ): { text?: string } {
    const providerRef: {
      current?: { provideLinks: (line: number, cb: (links: unknown) => void) => void };
    } = {};
    const term = {
      buffer: {
        active: {
          getLine: () => ({ translateToString: () => line }),
        },
      },
      registerLinkProvider: vi.fn((provider) => {
        providerRef.current = provider;
        return { dispose: vi.fn() };
      }),
    };
    registerFileDownloadLinkProvider(term as never, onDownload);

    const captured: { text?: string } = {};
    providerRef.current?.provideLinks(1, (links) => {
      const arr = links as
        | Array<{ text: string; activate: (event: MouseEvent, text: string) => void }>
        | undefined;
      if (!arr || arr.length === 0) return;
      const link = arr[0];
      if (!link) return;
      captured.text = link.text;
      link.activate(event as MouseEvent, link.text);
    });
    return captured;
  }

  // 与 image preview 同样的反误触 gate: 单击在终端里太容易碰到, cmd/ctrl+click 才触发下载。
  it("triggers download on cmd+click", () => {
    const onDownload = vi.fn();
    const captured = provideAndActivate(onDownload, { metaKey: true });
    expect(captured.text).toBe("./build/out.tar.gz");
    expect(onDownload).toHaveBeenCalledWith("./build/out.tar.gz");
  });

  it("triggers download on ctrl+click for non-mac users", () => {
    const onDownload = vi.fn();
    provideAndActivate(onDownload, { ctrlKey: true });
    expect(onDownload).toHaveBeenCalledWith("./build/out.tar.gz");
  });

  it("ignores plain clicks without a modifier (anti-misclick)", () => {
    const onDownload = vi.fn();
    provideAndActivate(onDownload, {});
    expect(onDownload).not.toHaveBeenCalled();
  });

  it("returns no links when the line has no recognizable file path", () => {
    const onDownload = vi.fn();
    const captured = provideAndActivate(onDownload, { metaKey: true }, "just plain text");
    expect(captured.text).toBeUndefined();
    expect(onDownload).not.toHaveBeenCalled();
  });
});
