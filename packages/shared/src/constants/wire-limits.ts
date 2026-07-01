// WebSocket wire limits shared by relay and proxy.
//
// PTY initial snapshots use JSON control messages because xterm serialize()
// returns ANSI text. A long 5000-line scrollback can legitimately exceed 1 MiB,
// so the JSON cap must cover terminal snapshots while still bounding parse cost.
export const RELAY_JSON_MESSAGE_MAX_BYTES = 8 * 1024 * 1024;

// Raw PTY output and remote-file chunks use binary frames. Keep this aligned
// with the relay-side frame guard.
export const RELAY_BINARY_FRAME_MAX_BYTES = 10 * 1024 * 1024;
