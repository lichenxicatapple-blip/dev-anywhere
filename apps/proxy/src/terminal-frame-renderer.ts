/**
 * 终端帧渲染器 -- 平台无关的 terminal_frame 处理逻辑
 *
 * 维护行 buffer，处理 full/delta 帧，管理 scrollback lineId 缓存。
 * 这是小程序 terminal-store + terminal-viewport 的核心逻辑预研，
 * Wave 3 的 Plan 08/10 应参考此实现。
 *
 * 平台适配：
 * - 终端 ANSI 输出：用 renderToAnsi() 适配
 * - 小程序 <Text> 组件：逐 span 映射为 <Text style={{color: fg}}>{text}</Text>
 */

export interface TermSpan {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
}

export type TermLine = TermSpan[];

interface DeltaEntry {
  lineIndex: number;
  spans: TermSpan[];
}

interface FullFramePayload {
  mode: "full";
  lines: TermLine[];
}

interface DeltaFramePayload {
  mode: "delta";
  lines: DeltaEntry[];
}

export interface TerminalFrame {
  type: "terminal_frame";
  sessionId: string;
  payload: FullFramePayload | DeltaFramePayload;
}

interface TerminalLinesResponse {
  type: "terminal_lines_response";
  sessionId: string;
  fromLineId: number;
  oldestLineId: number;
  newestLineId: number;
  lines: TermLine[];
}

/**
 * 终端帧渲染器
 *
 * 状态管理：
 * - viewportLines: 当前 viewport 行数组，由 terminal_frame 驱动更新
 * - scrollbackCache: lineId → TermLine 映射，由 terminal_lines_response 填充
 * - scrollPosition: 用户当前浏览位置（null = 跟随最新 viewport）
 */
export class TerminalFrameRenderer {
  private viewportLines: TermLine[] = [];
  private scrollbackCache = new Map<number, TermLine>();
  private _oldestLineId = 0;
  private _newestLineId = 0;
  private _scrollPosition: number | null = null;
  private onChange: (() => void) | null = null;

  /**
   * 注册变化回调，每次 viewport 或 scrollback 更新时触发
   */
  onUpdate(callback: () => void): void {
    this.onChange = callback;
  }

  /**
   * 处理收到的 terminal_frame 消息
   */
  applyFrame(frame: TerminalFrame): void {
    if (frame.payload.mode === "full") {
      this.viewportLines = frame.payload.lines.map((line) => [...line]);
    } else {
      for (const delta of frame.payload.lines) {
        while (this.viewportLines.length <= delta.lineIndex) {
          this.viewportLines.push([]);
        }
        this.viewportLines[delta.lineIndex] = [...delta.spans];
      }
    }
    this.onChange?.();
  }

  /**
   * 处理收到的 terminal_lines_response 消息
   */
  applyLinesResponse(response: TerminalLinesResponse): void {
    this._oldestLineId = response.oldestLineId;
    this._newestLineId = response.newestLineId;

    for (let i = 0; i < response.lines.length; i++) {
      const lineId = response.fromLineId + i;
      this.scrollbackCache.set(lineId, response.lines[i]);
    }
    this.onChange?.();
  }

  /**
   * 获取当前 viewport 行（最新画面）
   */
  getViewportLines(): TermLine[] {
    return this.viewportLines;
  }

  /**
   * 获取指定 lineId 范围的行（从 scrollback 缓存读取）
   * 返回 null 的位置表示该行未缓存，需要发 terminal_lines_request
   */
  getCachedLines(fromLineId: number, count: number): Array<TermLine | null> {
    const result: Array<TermLine | null> = [];
    for (let i = 0; i < count; i++) {
      result.push(this.scrollbackCache.get(fromLineId + i) ?? null);
    }
    return result;
  }

  /**
   * 找出指定范围中未缓存的 lineId 区间，用于决定 terminal_lines_request 的参数
   */
  getMissingRange(fromLineId: number, count: number): { fromLineId: number; count: number } | null {
    let missingStart = -1;
    let missingEnd = -1;

    for (let i = 0; i < count; i++) {
      const id = fromLineId + i;
      if (!this.scrollbackCache.has(id)) {
        if (missingStart === -1) missingStart = id;
        missingEnd = id;
      }
    }

    if (missingStart === -1) return null;
    return { fromLineId: missingStart, count: missingEnd - missingStart + 1 };
  }

  /**
   * 设置滚动位置（lineId），null 表示跟随最新 viewport
   */
  setScrollPosition(lineId: number | null): void {
    this._scrollPosition = lineId;
  }

  get scrollPosition(): number | null {
    return this._scrollPosition;
  }

  get oldestLineId(): number {
    return this._oldestLineId;
  }

  get newestLineId(): number {
    return this._newestLineId;
  }

  /**
   * 清空 scrollback 缓存（断线重连、会话切换时调用）
   */
  clearCache(): void {
    this.scrollbackCache.clear();
    this._scrollPosition = null;
  }

  get cacheSize(): number {
    return this.scrollbackCache.size;
  }
}

/**
 * 终端 ANSI 适配器：将 TermLine 渲染为终端彩色文本
 *
 * 小程序端不用这个，用 <Text style={{color, fontWeight}}> 替代。
 */
export function renderLineToAnsi(line: TermLine): string {
  return line.map((span) => {
    let result = "";
    if (span.bold) result += "\x1b[1m";
    if (span.fg) {
      const hex = span.fg.replace("#", "");
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      result += `\x1b[38;2;${r};${g};${b}m`;
    }
    if (span.bg) {
      const hex = span.bg.replace("#", "");
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      result += `\x1b[48;2;${r};${g};${b}m`;
    }
    result += span.text;
    if (span.fg || span.bg || span.bold) result += "\x1b[0m";
    return result;
  }).join("");
}

/**
 * 将整个 viewport 渲染到终端
 */
export function renderViewportToTerminal(renderer: TerminalFrameRenderer): void {
  const lines = renderer.getViewportLines();
  process.stdout.write("\x1b[H"); // 光标到左上角
  for (let i = 0; i < lines.length; i++) {
    process.stdout.write(renderLineToAnsi(lines[i]) + "\x1b[K");
    if (i < lines.length - 1) process.stdout.write("\r\n");
  }
  // 用绝对定位到 viewport 下方清除剩余行，避免最后一行 \r\n 引起滚动
  process.stdout.write(`\x1b[${lines.length + 1};1H\x1b[J`);
}
