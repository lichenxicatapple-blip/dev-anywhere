interface PtyConnectionOverlayProps {
  connecting: boolean;
  subscribeDelayed: boolean;
}

export function PtyConnectionOverlay({ connecting, subscribeDelayed }: PtyConnectionOverlayProps) {
  if (connecting && !subscribeDelayed) {
    return (
      <div
        className="absolute top-0 left-0 right-0 h-8 flex items-center justify-center bg-card/60 text-xs text-muted-foreground"
        data-slot="pty-connecting"
      >
        正在连接终端...
      </div>
    );
  }

  if (!subscribeDelayed) return null;

  return (
    <div
      className="absolute top-0 left-0 right-0 h-8 flex items-center justify-center bg-card/70 text-xs text-muted-foreground"
      data-slot="pty-subscribe-delayed"
      role="status"
      aria-live="polite"
    >
      正在同步终端画面，低带宽网络可能需要更久
    </div>
  );
}
