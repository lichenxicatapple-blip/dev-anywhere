export type CopyTextResult = "clipboard" | "failed";

export async function copyText(text: string): Promise<CopyTextResult> {
  const writeText = navigator.clipboard?.writeText?.bind(navigator.clipboard);
  if (!writeText || window.isSecureContext === false) {
    return "failed";
  }

  try {
    await writeText(text);
    return "clipboard";
  } catch {
    return "failed";
  }
}
