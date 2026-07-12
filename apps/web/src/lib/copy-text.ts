type CopyTextResult = "clipboard" | "legacy" | "failed";

interface CopyTextOptions {
  allowLegacyFallback?: boolean;
}

export async function copyText(
  text: string,
  { allowLegacyFallback = false }: CopyTextOptions = {},
): Promise<CopyTextResult> {
  const writeText = navigator.clipboard?.writeText?.bind(navigator.clipboard);
  if (writeText && window.isSecureContext !== false) {
    try {
      await writeText(text);
      return "clipboard";
    } catch {
      // Continue to the user-gesture fallback when the caller explicitly allows it.
    }
  }

  if (!allowLegacyFallback) return "failed";
  return copyTextFromActiveUserGesture(text) ? "legacy" : "failed";
}

function copyTextFromActiveUserGesture(text: string): boolean {
  if (!document.body || typeof document.execCommand !== "function") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  textarea.style.fontSize = "16px";
  document.body.appendChild(textarea);

  try {
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}
