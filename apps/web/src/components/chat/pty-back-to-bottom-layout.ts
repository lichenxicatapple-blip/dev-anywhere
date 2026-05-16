interface PtyBackToBottomLayoutOptions {
  showMobilePtyControls: boolean;
  touchEditingSurface: boolean;
  horizontalScrollable: boolean;
}

export function getPtyBackToBottomClassName({
  showMobilePtyControls,
  touchEditingSurface,
  horizontalScrollable,
}: PtyBackToBottomLayoutOptions): string {
  if (showMobilePtyControls) {
    return "right-5 md:right-6 bottom-[calc(env(safe-area-inset-bottom)+7rem)]";
  }

  const rightOffset = touchEditingSurface ? "right-5" : "right-6";
  const bottomOffset = horizontalScrollable ? "bottom-12" : "bottom-5";
  return `${rightOffset} ${bottomOffset}`;
}
