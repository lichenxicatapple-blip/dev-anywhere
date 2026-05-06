interface PtyConnectionOverlayProps {
  connecting: boolean;
  subscribeExhausted: boolean;
  onRetry: () => void;
}

export function PtyConnectionOverlay({
  connecting,
  subscribeExhausted,
  onRetry,
}: PtyConnectionOverlayProps) {
  if (connecting && !subscribeExhausted) {
    return (
      <div
        className="absolute top-0 left-0 right-0 h-8 flex items-center justify-center bg-card/60 text-xs text-muted-foreground"
        data-slot="pty-connecting"
      >
        PTY 正在连接...
      </div>
    );
  }

  if (!subscribeExhausted) return null;

  return (
    <div
      className="absolute top-0 left-0 right-0 h-10 flex items-center justify-center gap-3 bg-destructive/10 text-xs text-destructive"
      data-slot="pty-subscribe-failed"
      role="alert"
    >
      <span>PTY 订阅未响应，请重试</span>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-sm border border-destructive/40 px-2 py-0.5 text-destructive hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
      >
        重试
      </button>
    </div>
  );
}
