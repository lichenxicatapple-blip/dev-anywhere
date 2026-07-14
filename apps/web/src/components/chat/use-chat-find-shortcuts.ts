import { useCallback, useEffect, useRef, useState } from "react";

interface UseChatFindShortcutsOptions {
  enabled?: boolean;
  open: boolean;
  openRequest?: number;
  onOpen: () => void;
  onClose: () => void;
  onPrevious: () => void;
  onNext: () => void;
}

export function useChatFindShortcuts({
  enabled = true,
  open,
  openRequest,
  onOpen,
  onClose,
  onPrevious,
  onNext,
}: UseChatFindShortcutsOptions): {
  focusRequest: number;
  openFind: () => void;
  closeFind: () => void;
} {
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const lastOpenRequestRef = useRef(openRequest);
  const [focusRequest, setFocusRequest] = useState(0);

  const openFind = useCallback(() => {
    if (!open && document.activeElement instanceof HTMLElement) {
      previousFocusRef.current = document.activeElement;
    }
    setFocusRequest((request) => request + 1);
    onOpen();
  }, [onOpen, open]);

  const closeFind = useCallback(() => {
    onClose();
    const previousFocus = previousFocusRef.current;
    previousFocusRef.current = null;
    requestAnimationFrame(() => {
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    });
  }, [onClose]);

  useEffect(() => {
    if (!enabled || openRequest === undefined) return;
    if (lastOpenRequestRef.current === openRequest) return;
    lastOpenRequestRef.current = openRequest;
    openFind();
  }, [enabled, openFind, openRequest]);

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      const commandModifier = (event.metaKey || event.ctrlKey) && !event.altKey;
      const key = event.key.toLowerCase();

      if (commandModifier && !event.shiftKey && key === "f") {
        event.preventDefault();
        event.stopPropagation();
        openFind();
        return;
      }

      if (open && commandModifier && key === "g") {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) onPrevious();
        else onNext();
        return;
      }

      if (open && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeFind();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [closeFind, enabled, onNext, onPrevious, open, openFind]);

  return { focusRequest, openFind, closeFind };
}
