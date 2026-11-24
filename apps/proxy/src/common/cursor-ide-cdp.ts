import WebSocket from "ws";

export interface CursorIdeTarget {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/** Errors with fixed, user-facing text; never expose arbitrary CDP or page output. */
export class CursorIdeError extends Error {}

const CDP_ORIGIN = "http://127.0.0.1:9222";

export class CursorIdeConnection {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
        };
        if (msg.id === undefined) return;
        const request = this.pending.get(msg.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(msg.id);
        if (msg.error) request.reject(new Error(msg.error.message ?? "CDP request failed"));
        else request.resolve(msg.result);
      } catch {
        // Ignore unsolicited or malformed CDP events.
      }
    });
    socket.on("close", () => this.rejectPending());
    socket.on("error", () => this.rejectPending());
  }

  static async connect(url: string): Promise<CursorIdeConnection> {
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" || parsed.hostname !== "127.0.0.1" || parsed.port !== "9222") {
      throw new CursorIdeError("Cursor 返回了非本机调试地址，已停止连接");
    }
    const socket = new WebSocket(url, { handshakeTimeout: 5000 });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
    } catch {
      throw new CursorIdeError("无法连接 Cursor 窗口，请确认 Cursor 调试端口可用后重试");
    }
    return new CursorIdeConnection(socket);
  }

  private rejectPending(): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new CursorIdeError("Cursor IDE 调试连接已断开，请检查 Cursor 是否仍在运行"));
    }
    this.pending.clear();
  }

  async evaluate<T>(expression: string): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new CursorIdeError("Cursor IDE 调试连接已断开，请检查 Cursor 是否仍在运行");
    }
    const id = ++this.nextId;
    const response = (await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CursorIdeError("Cursor IDE 响应超时，请检查 Cursor 窗口后重试"));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
        (error) => {
          if (!error) return;
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        },
      );
    })) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
    if (response.exceptionDetails) throw new Error("Cursor IDE page evaluation failed");
    return response.result?.value as T;
  }

  close(): void {
    this.socket.close();
  }
}

export async function cursorIdeTargets(): Promise<CursorIdeTarget[]> {
  let response: Response;
  try {
    response = await fetch(`${CDP_ORIGIN}/json`, { signal: AbortSignal.timeout(5000) });
  } catch {
    throw new CursorIdeError(
      "无法连接 Cursor IDE，请确认 Cursor 已使用 --remote-debugging-port=9222 启动",
    );
  }
  if (!response.ok) throw new CursorIdeError("Cursor IDE 调试端口不可用，请重启 Cursor 后重试");
  const all = (await response.json()) as CursorIdeTarget[];
  return all.filter(
    (target) =>
      target.type === "page" && target.url.includes("workbench") && target.webSocketDebuggerUrl,
  );
}
