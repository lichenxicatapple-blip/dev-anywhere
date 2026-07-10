const PTY_HELPER_TEXTAREA_CLASS = "xterm-helper-textarea";

export function blurActivePtyHelperTextarea(activeElement: Element | null = document.activeElement): boolean {
  if (!(activeElement instanceof HTMLElement)) return false;
  if (!activeElement.classList.contains(PTY_HELPER_TEXTAREA_CLASS)) return false;
  activeElement.blur();
  return true;
}

export function canScrollVerticallyWithinBoundary(
  target: EventTarget | null,
  boundary: HTMLElement,
  deltaY: number,
): boolean {
  if (!target || Math.abs(deltaY) < 1) return false;
  let element = target instanceof Element ? target : null;
  while (element && boundary.contains(element)) {
    if (element instanceof HTMLElement && canElementScrollY(element, deltaY)) return true;
    if (element === boundary) break;
    element = element.parentElement;
  }
  return false;
}

export function canElementScrollY(element: HTMLElement, deltaY: number): boolean {
  if (element.scrollHeight <= element.clientHeight + 1) return false;
  const overflowY = window.getComputedStyle(element).overflowY;
  if (overflowY !== "auto" && overflowY !== "scroll" && overflowY !== "overlay") return false;
  if (deltaY < 0) return element.scrollTop > 0;
  return element.scrollTop + element.clientHeight < element.scrollHeight - 1;
}
