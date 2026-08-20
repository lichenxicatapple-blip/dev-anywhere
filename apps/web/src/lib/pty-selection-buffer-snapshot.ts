import type { IBufferCell, IBufferLine } from "@xterm/xterm";

const CELL_WIDTH_MASK = 0b0000_0011;
const CELL_HAS_CONTENT = 0b0000_0100;

/**
 * Clone the public, text-relevant part of an xterm line.
 *
 * xterm recycles mutable buffer lines as output arrives. A managed selection must keep the exact
 * cells the user saw when the range was established, especially when the visible review layer is
 * an older frozen projection of that buffer.
 */
export function snapshotPtySelectionBufferLine(line: IBufferLine, cols: number): IBufferLine {
  const length = Math.max(0, Math.min(line.length, cols));
  const offsets = new Uint32Array(length + 1);
  const metadata = new Uint8Array(length);
  const translatedCellParts = new Array<string>(length);
  let translatedLength = 0;
  let trimmedLength = 0;
  let reusableCell: IBufferCell | undefined;

  for (let column = 0; column < length; column += 1) {
    const cell = line.getCell(column, reusableCell);
    if (cell) reusableCell = cell;
    const chars = cell?.getChars() ?? "";
    const width = (cell?.getWidth() ?? 1) & CELL_WIDTH_MASK;
    const hasContent = chars.length > 0;

    offsets[column] = translatedLength;
    translatedCellParts[column] = width === 0 ? "" : hasContent ? chars : " ";
    translatedLength += translatedCellParts[column].length;
    offsets[column + 1] = translatedLength;
    metadata[column] = width | (hasContent ? CELL_HAS_CONTENT : 0);
    if (hasContent) trimmedLength = column + width;
  }
  const translatedCells = translatedCellParts.join("");

  const getCell = (column: number): IBufferCell | undefined => {
    if (!Number.isInteger(column) || column < 0 || column >= length) return undefined;
    const cellMetadata = metadata[column];
    const chars =
      cellMetadata & CELL_HAS_CONTENT
        ? translatedCells.slice(offsets[column], offsets[column + 1])
        : "";
    const width = cellMetadata & CELL_WIDTH_MASK;
    return {
      getChars: () => chars,
      getWidth: () => width,
    } as unknown as IBufferCell;
  };

  return {
    length,
    isWrapped: line.isWrapped,
    getCell,
    translateToString: (trimRight = false, startColumn = 0, endColumn = length) => {
      const start = Math.max(0, Math.min(length, startColumn));
      const end = Math.max(start, Math.min(length, endColumn));
      const translatedEnd = trimRight ? Math.min(end, trimmedLength) : end;
      if (!Number.isInteger(start) || !Number.isInteger(translatedEnd) || translatedEnd <= start) {
        return "";
      }
      // xterm jumps over continuation cells when translation begins at the wide glyph. If the
      // requested range itself begins on a continuation, xterm instead emits one blank for each
      // leading width-0 cell before resuming normal translation.
      let translatedStart = start;
      while (
        translatedStart < translatedEnd &&
        (metadata[translatedStart] & CELL_WIDTH_MASK) === 0
      ) {
        translatedStart += 1;
      }
      const leadingContinuationCount = translatedStart - start;
      const translated = translatedCells.slice(offsets[translatedStart], offsets[translatedEnd]);
      return leadingContinuationCount > 0
        ? `${" ".repeat(leadingContinuationCount)}${translated}`
        : translated;
    },
  } as unknown as IBufferLine;
}

export function rebasePtySelectionLineSnapshots(
  lines: ReadonlyMap<number, IBufferLine>,
  delta: number,
): Map<number, IBufferLine> {
  if (!Number.isInteger(delta) || delta === 0) return new Map(lines);
  const rebased = new Map<number, IBufferLine>();
  for (const [row, line] of lines) {
    const nextRow = row + delta;
    if (nextRow >= 0) rebased.set(nextRow, line);
  }
  return rebased;
}
