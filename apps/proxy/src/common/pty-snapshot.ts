export interface PtySnapshot {
  cols: number;
  rows: number;
  data: string;
  outputSeq: number;
}

interface PtySnapshotTerminal {
  readonly cols: number;
  readonly rows: number;
  write(data: string | Uint8Array, callback?: () => void): void;
}

interface PtySnapshotSerializer {
  serialize(): string;
}

export function capturePtySnapshot(
  terminal: PtySnapshotTerminal,
  serializer: PtySnapshotSerializer,
  outputSeq: number,
  onSnapshot: (snapshot: PtySnapshot) => void,
): void {
  // xterm processes write() asynchronously. An empty write is an ordered barrier:
  // its callback runs after all output represented by outputSeq has reached the buffer.
  terminal.write("", () => {
    onSnapshot({
      cols: terminal.cols,
      rows: terminal.rows,
      data: serializer.serialize(),
      outputSeq,
    });
  });
}
