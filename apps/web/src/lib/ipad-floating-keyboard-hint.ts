import { readStorageValue, STORAGE_KEYS, writeStorageValue } from "@/lib/storage-keys";

interface FloatingKeyboardHintState {
  isIpad: boolean;
  isLandscape: boolean;
  isPty: boolean;
  keyboardOpen: boolean;
  shownForCurrentKeyboardOpen: boolean;
  dismissed: boolean;
}

export function shouldShowFloatingKeyboardHint({
  isIpad,
  isLandscape,
  isPty,
  keyboardOpen,
  shownForCurrentKeyboardOpen,
  dismissed,
}: FloatingKeyboardHintState): boolean {
  return (
    isIpad && isLandscape && isPty && keyboardOpen && !shownForCurrentKeyboardOpen && !dismissed
  );
}

export function isFloatingKeyboardHintDismissed(): boolean {
  return readStorageValue("local", STORAGE_KEYS.ipadFloatingKeyboardHintDismissed) === "1";
}

export function dismissFloatingKeyboardHint(): void {
  writeStorageValue("local", STORAGE_KEYS.ipadFloatingKeyboardHintDismissed, "1");
}
