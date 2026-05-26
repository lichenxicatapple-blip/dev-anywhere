interface PtyBackToBottomLayoutOptions {
  showMobilePtyControls: boolean;
  touchEditingSurface: boolean;
  horizontalScrollable: boolean;
}

export function getPtyBackToBottomClassName({
  showMobilePtyControls,
  horizontalScrollable,
}: PtyBackToBottomLayoutOptions): string {
  if (showMobilePtyControls) {
    return "bottom-[calc(env(safe-area-inset-bottom)+7rem)]";
  }

  const bottomOffset = horizontalScrollable ? "bottom-12" : "bottom-5";
  return bottomOffset;
}
