// Keep xterm's own textarea under the native menu, including clicks in the surrounding blank
// terminal surface. Using the original node preserves xterm paste and the file-upload handlers.
export function preparePtyContextMenu(
  textarea: HTMLTextAreaElement,
  point: { clientX: number; clientY: number },
  selectedText: string,
): () => void {
  const document = textarea.ownerDocument;
  const window = document.defaultView;
  const helpers = textarea.closest<HTMLElement>(".xterm-helpers");
  if (!helpers) return () => {};
  let active = true;
  const reset = (): void => {
    if (!active) return;
    active = false;
    textarea.removeAttribute("data-pty-context-menu");
    helpers.style.removeProperty("--pty-context-menu-x");
    helpers.style.removeProperty("--pty-context-menu-y");
    for (const type of interactionEvents) document.removeEventListener(type, reset, true);
    for (const type of clipboardEvents) document.removeEventListener(type, afterClipboard, true);
    textarea.removeEventListener("blur", reset);
    window?.removeEventListener("resize", reset);
  };
  // Copy/Paste must finish reading the selection before relinquishing the menu target. Capturing
  // on document also sees file paste and managed copy, which stop propagation farther down.
  const afterClipboard = (): void => queueMicrotask(reset);
  const interactionEvents = ["pointerdown", "keydown", "compositionstart", "wheel"] as const;
  const clipboardEvents = ["copy", "cut", "paste"] as const;

  helpers.style.setProperty("--pty-context-menu-x", `${point.clientX - 10}px`);
  helpers.style.setProperty("--pty-context-menu-y", `${point.clientY - 10}px`);
  textarea.setAttribute("data-pty-context-menu", "");
  textarea.value = selectedText;
  textarea.focus({ preventScroll: true });
  textarea.select();

  // There is no browser menu-close event. Release on the next interaction, before xterm/IME
  // handlers run; a short timer or pointerup can restore the node before the menu even opens.
  for (const type of interactionEvents) document.addEventListener(type, reset, true);
  for (const type of clipboardEvents) document.addEventListener(type, afterClipboard, true);
  textarea.addEventListener("blur", reset);
  window?.addEventListener("resize", reset);
  return reset;
}
