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
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

export type TermLine = TermSpan[];

interface DeltaEntry {
  lineIndex: number;
  spans: TermSpan[];
}

interface CursorPosition {
  x: number;
  y: number;
}

interface FullFramePayload {
  mode: "full";
  lines: TermLine[];
  cursor?: CursorPosition;
}

interface DeltaFramePayload {
  mode: "delta";
  lines: DeltaEntry[];
  cursor?: CursorPosition;
}

export interface TerminalFrame {
  type: "terminal_frame";
  sessionId: string;
  payload: FullFramePayload | DeltaFramePayload;
}

/**
 * 终端帧渲染器
 *
 * 状态管理：
 * - viewportLines: 当前 viewport 行数组，由 terminal_frame 驱动更新
 * - server-side scrolling 架构下 client 只接收 frame，不维护 scrollback cache
 */
export class TerminalFrameRenderer {
  private viewportLines: TermLine[] = [];
  private _cursor: CursorPosition | null = null;
  private onChange: (() => void) | null = null;

  /**
   * 注册变化回调，每次 viewport 更新时触发
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
    this._cursor = frame.payload.cursor ?? null;
    this.onChange?.();
  }

  get cursor(): CursorPosition | null {
    return this._cursor;
  }

  /**
   * 获取当前 viewport 行（最新画面）
   */
  getViewportLines(): TermLine[] {
    return this.viewportLines;
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
    const hasStyle = span.bold || span.dim || span.italic || span.underline || span.strikethrough || span.fg || span.bg;
    if (span.bold) result += "\x1b[1m";
    if (span.dim) result += "\x1b[2m";
    if (span.italic) result += "\x1b[3m";
    if (span.underline) result += "\x1b[4m";
    if (span.strikethrough) result += "\x1b[9m";
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
    if (hasStyle) result += "\x1b[0m";
    return result;
  }).join("");
}

/**
 * 将整个 viewport 渲染到终端
 */
export function renderViewportToTerminal(renderer: TerminalFrameRenderer): void {
  const lines = renderer.getViewportLines();
  const termRows = process.stdout.rows ?? 24;
  process.stdout.write("\x1b[H"); // 光标到左上角
  for (let i = 0; i < lines.length; i++) {
    process.stdout.write(renderLineToAnsi(lines[i]) + "\x1b[K");
    if (i < lines.length - 1) process.stdout.write("\r\n");
  }
  // viewport 未填满终端时，清除下方剩余行
  if (lines.length < termRows) {
    process.stdout.write(`\x1b[${lines.length + 1};1H\x1b[J`);
  }
  // 定位光标到 xterm 报告的位置
  const cursor = renderer.cursor;
  if (cursor) {
    process.stdout.write(`\x1b[${cursor.y + 1};${cursor.x + 1}H\x1b[?25h`);
  }
}
