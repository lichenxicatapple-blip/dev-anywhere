# PTY full-chain sync benchmark

This opt-in benchmark reproduces the production long-session workload locally without a real
Claude/Codex process or API call:

- real shell terminal worker at `179x37` with a 5000-row, approximately 1.05 MB snapshot;
- deterministic mixed logs/code/JSON/diagnostics/CJK content whose level-3 deflate ratio is about
  3.5:1 (intentionally more conservative than the observed production session's roughly 7.9:1);
- continuous output at 38 `outputSeq` frames per second;
- real Proxy, Relay, Vite WebSocket proxy, Chromium, xterm parser, and paint boundary;
- one shared deterministic Relay-to-browser downlink, defaulting to 300 KiB/s and 25 ms latency;
- independent 1, 3, and 5-browser scenarios.

Run the standard matrix from the repository root:

```sh
bash scripts/benchmark/pty-sync.sh
```

Run a fast single-client sample without rebuilding already-current dist files:

```sh
PTY_SYNC_BENCH_SKIP_BUILD=1 \
PTY_SYNC_BENCH_CLIENTS=1 \
bash scripts/benchmark/pty-sync.sh
```

The main controls are:

| Variable                              |       Default | Meaning                                                            |
| ------------------------------------- | ------------: | ------------------------------------------------------------------ |
| `PTY_SYNC_BENCH_CLIENTS`              |       `1,3,5` | Comma-separated scenario list; accepted values are 1, 3, and 5.    |
| `PTY_SYNC_BENCH_DOWNLINK_BPS`         |      `307200` | Shared Relay-to-browser bytes per second.                          |
| `PTY_SYNC_BENCH_LATENCY_MS`           |          `25` | Added downstream chunk latency.                                    |
| `PTY_SYNC_BENCH_READY_TIMEOUT_MS`     |      `240000` | Per-scenario wait for all clients to apply snapshot replay.        |
| `PTY_SYNC_BENCH_WATERMARK_TIMEOUT_MS` |       `90000` | Wait for the exact tail watermark to reach xterm and paint.        |
| `PTY_SYNC_BENCH_LABEL`                | UTC timestamp | Prefix for result files. Use `before` and `after` for comparisons. |
| `PTY_SYNC_BENCH_OUTPUT`               | artifact path | Output template; `{clients}` is replaced with the scenario size.   |

Each scenario writes JSON under `artifacts/benchmarks/pty-sync/` and attaches the same JSON to the
Playwright result. A successful record has `status: "complete"`. A timeout or assertion failure
still writes `status: "incomplete"`, the failed phase, downlink queue state, and every browser's
partial snapshot/retry/watermark observations before the test reports failure.

Correctness gates are part of the benchmark, not optional performance shortcuts. For the applied
snapshot watermark `S` and injected live tail watermark `N`, every browser must receive exactly
`S+1 ... N` with no gap or duplicate, render the final watermark in its terminal buffer, pass an
xterm write callback, and then pass two animation frames. Metrics also separate the applied
snapshot from all matching retry snapshots and non-matching snapshots requested by other clients.

Bandwidth gates use bytes observed on the shaped raw TCP downlink, after WebSocket compression and
including framing, control traffic, and ongoing uncompressed PTY binary output. Every browser must
negotiate `permessage-deflate`, receive exactly one matching snapshot and zero foreign snapshots,
and the whole-channel wire bytes must stay below 65% of the uncompressed one-snapshot-per-client
fanout. The JSON report records that ratio together with total/peak queued bytes, so a speedup cannot
hide Relay bandwidth amplification.

For a controlled before/after comparison, keep the same machine idle and run:

```sh
PTY_SYNC_BENCH_LABEL=before bash scripts/benchmark/pty-sync.sh
# apply and build the implementation change
PTY_SYNC_BENCH_LABEL=after bash scripts/benchmark/pty-sync.sh
```

## Reference result (2026-08-21)

Measured on an Apple M4 Pro with 64 GiB RAM, Node 25.2.1, at the default 300 KiB/s shared
downlink and 25 ms added latency. The end-to-end value starts at the outgoing subscribe and ends
only after an exact live tail watermark has reached xterm's write callback and two paint frames.

| Clients |  Previous end-to-end | Optimized end-to-end (4 runs) | Previous downlink | Optimized downlink | Foreign snapshots after |
| ------: | -------------------: | ----------------------------: | ----------------: | -----------------: | ----------------------: |
|       1 |              4.580 s |                 1.616–1.634 s |          1.108 MB |           0.309 MB |                     0 B |
|       3 |             45.672 s |                 3.209–3.628 s |         14.023 MB |     0.982–0.994 MB |                     0 B |
|       5 | `>300 s`, incomplete |                 5.784–5.883 s |        incomplete |     1.762–1.767 MB |                     0 B |

All optimized runs used one matching snapshot per client, zero retries, and zero `outputSeq` gaps
or duplicates. For one client, snapshot receipt to ready fell from 963 ms to 50–56 ms after the
xterm scroll reconciliation was coalesced. The previous and optimized raw snapshots were 1.055 MB
and 1.048 MB respectively; the optimized workload deliberately has higher entropy so compression
is not being credited with an unrealistically repetitive fixture.
