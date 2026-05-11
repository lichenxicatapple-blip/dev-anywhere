import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { atomicWriteFileSync } from "./atomic-write.js";
import { sessionPaths } from "./paths.js";

// 一次预留多少个 seq, 减少 sync writeFileSync 频次。每 N 次 next() 才写一次磁盘,
// 写的是 reservation 高水位 (seq + N), 不是 current seq。
// 重启后 load() 读到 reservation, 当前 seq 直接跳到 reservation, 后续 next() 从那里
// 续——已用但未持久化的 [reservation - N + 1 .. reservation] 区间被"浪费", 但 wire 上
// 不会发出 collision 的 seq, 接收方 (relay/web) 看不到回退/重复。
const RESERVATION_BATCH = 100;

/**
 * 轻量级 per-session seq 计数器，持久化到文件
 *
 * 仅存储一个递增整数，proxy 重启后能接续 (按 reservation batch 跳跃, 不保证 contiguous)。
 */
export class SeqCounter {
  private seq: number = 0;
  // 已持久化的高水位; seq <= reservedUpTo 时 next() 不需要写盘
  private reservedUpTo: number = 0;
  private readonly filePath: string;

  constructor(sessionId: string, baseDir?: string) {
    const dir = baseDir ?? sessionPaths(sessionId).dir;
    mkdirSync(dir, { recursive: true });
    this.filePath = `${dir}/seq`;
    this.load();
  }

  next(): number {
    this.seq++;
    if (this.seq > this.reservedUpTo) {
      this.reservedUpTo = this.seq + RESERVATION_BATCH - 1;
      this.save();
    }
    return this.seq;
  }

  current(): number {
    return this.seq;
  }

  // 显式持久化当前 seq, 不再保留 batch——优雅退出时调用, 让重启续号尽量贴近真实进度。
  flush(): void {
    if (this.seq !== this.reservedUpTo) {
      this.reservedUpTo = this.seq;
      this.save();
    }
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    const content = readFileSync(this.filePath, "utf-8").trim();
    const parsed = parseInt(content, 10);
    if (isNaN(parsed) || parsed < 0) {
      throw new Error(`Corrupt seq file: ${this.filePath} contains "${content}"`);
    }
    // 重启续号: 直接跳到上次预留的高水位, 把已用未持久化的区间作废, 避免 wire collision。
    this.seq = parsed;
    this.reservedUpTo = parsed;
  }

  private save(): void {
    atomicWriteFileSync(this.filePath, String(this.reservedUpTo));
  }
}

// per-session 进程内缓存。production 路径 (event-bridge / hook-event-router /
// worker-registry) 之前每条 envelope 都 new SeqCounter(sessionId).next(), 每次
// 都 readFileSync + writeFileSync——hot path 双写加倍。改走 getSeqCounterFor 共享
// 同一实例, 配合 reservation batch 把磁盘写从 100 Hz 降到 ~1 Hz。
const seqCounterCache = new Map<string, SeqCounter>();

export function getSeqCounterFor(sessionId: string, baseDir?: string): SeqCounter {
  let counter = seqCounterCache.get(sessionId);
  if (!counter) {
    counter = new SeqCounter(sessionId, baseDir);
    seqCounterCache.set(sessionId, counter);
  }
  return counter;
}

// session 终止时调用, 把 counter 从缓存里摘掉。不再 flush:
// terminateSession 的 onSessionRemoved 已经 rmSync session 目录, 紧接着 cleanupSessionResources
// 调本函数, flush 会写到一个不存在的路径报 ENOENT。flush 的语义是"优雅退出 process 时让重启
// 续号尽量贴近真实进度", 而 sessionId 是 nanoid 不复用, terminate 后的续号没意义。
export function disposeSeqCounter(sessionId: string): void {
  seqCounterCache.delete(sessionId);
}
