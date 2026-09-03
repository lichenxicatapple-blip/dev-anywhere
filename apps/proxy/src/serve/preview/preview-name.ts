const MAX_PREVIEW_NAME_LENGTH = 256;

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function normalizedPreviewName(value: string): string {
  const name = value.trim();
  if (!name) throw new Error("预览名称不能为空");
  if (name.length > MAX_PREVIEW_NAME_LENGTH) {
    throw new Error(`预览名称不能超过 ${MAX_PREVIEW_NAME_LENGTH} 个字符`);
  }
  if (containsControlCharacter(name)) {
    throw new Error("预览名称不能包含控制字符");
  }
  return name;
}

/** An omitted or whitespace-only create name asks the manager to generate its default name. */
export function normalizeOptionalPreviewName(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return normalizedPreviewName(value);
}

export function normalizeRequiredPreviewName(value: string): string {
  return normalizedPreviewName(value);
}
