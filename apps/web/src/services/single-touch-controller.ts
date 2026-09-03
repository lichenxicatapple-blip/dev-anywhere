import type { DevicePreviewInput } from "@dev-anywhere/shared";

interface SingleTouchPoint {
  readonly x: number;
  readonly y: number;
}

type TouchInput = Extract<DevicePreviewInput, { kind: "touch" }>;

interface ActiveTouch {
  readonly pointerId: number;
  lastPoint: SingleTouchPoint;
  lastMoveAt: number;
  pendingMove: SingleTouchPoint | null;
  moveFlushTimer: ReturnType<typeof setTimeout> | null;
}

export interface SingleTouchControllerOptions {
  /** Sends one input through the stream access this controller was created for. */
  readonly send: (input: TouchInput) => Promise<void>;
  /** Invalidates that stream access. Called at most once for this controller. */
  readonly onFailure: (error: unknown) => void;
  readonly now?: () => number;
  readonly moveFlushMs?: number;
  readonly maxInFlightMoves?: number;
}

const DEFAULT_MOVE_FLUSH_MS = 16;
const DEFAULT_MAX_IN_FLIGHT_MOVES = 16;

/**
 * Owns the single-pointer lifecycle for exactly one device-preview stream access.
 *
 * DOM capture and coordinate mapping intentionally stay outside this class. A failed input makes
 * the entire access ambiguous, so it is failed closed instead of trying to continue a partially
 * acknowledged native touch sequence.
 */
export class SingleTouchController {
  private readonly send: (input: TouchInput) => Promise<void>;
  private readonly onFailure: (error: unknown) => void;
  private readonly now: () => number;
  private readonly moveFlushMs: number;
  private readonly maxInFlightMoves: number;

  private active: ActiveTouch | null = null;
  private inFlightMoves = 0;
  private disposed = false;
  private failed = false;

  constructor(options: SingleTouchControllerOptions) {
    this.send = options.send;
    this.onFailure = options.onFailure;
    this.now = options.now ?? (() => performance.now());
    this.moveFlushMs = options.moveFlushMs ?? DEFAULT_MOVE_FLUSH_MS;
    this.maxInFlightMoves = options.maxInFlightMoves ?? DEFAULT_MAX_IN_FLIGHT_MOVES;
  }

  begin(pointerId: number, point: SingleTouchPoint): boolean {
    if (this.disposed || this.failed || this.active) return false;
    const active: ActiveTouch = {
      pointerId,
      lastPoint: point,
      lastMoveAt: Number.NEGATIVE_INFINITY,
      pendingMove: null,
      moveFlushTimer: null,
    };
    this.active = active;
    this.dispatch(this.input("down", point));
    return true;
  }

  move(pointerId: number, point: SingleTouchPoint): boolean {
    const active = this.matchingActive(pointerId);
    if (!active) return false;
    active.lastPoint = point;
    active.pendingMove = point;

    const now = this.now();
    const waitMs = this.moveFlushMs - (now - active.lastMoveAt);
    if (waitMs > 0) {
      if (active.moveFlushTimer === null) {
        active.moveFlushTimer = setTimeout(() => {
          active.moveFlushTimer = null;
          if (this.active !== active || this.disposed || this.failed) return;
          active.lastMoveAt = this.now();
          this.flushLatestMove();
        }, waitMs);
      }
      return true;
    }

    this.clearMoveTimer(active);
    active.lastMoveAt = now;
    this.flushLatestMove();
    return true;
  }

  end(pointerId: number, point: SingleTouchPoint): boolean {
    const active = this.matchingActive(pointerId);
    if (!active) return false;
    active.lastPoint = point;
    this.finish(active);
    this.dispatch(this.input("up", point));
    return true;
  }

  cancel(pointerId?: number): boolean {
    const active = this.active;
    if (!active || (pointerId !== undefined && active.pointerId !== pointerId)) return false;
    const point = active.lastPoint;
    this.finish(active);
    this.dispatch(this.input("up", point));
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    const active = this.active;
    if (active) this.finish(active);
    this.disposed = true;
    if (!active || this.failed) return;

    // The access is being replaced, so this is cleanup only. A late/failed acknowledgement belongs
    // to the disposed generation and must never poison the replacement controller.
    try {
      void Promise.resolve(this.send(this.input("up", active.lastPoint))).catch(() => {});
    } catch {
      // Best effort by design.
    }
  }

  private matchingActive(pointerId: number): ActiveTouch | null {
    if (this.disposed || this.failed || this.active?.pointerId !== pointerId) return null;
    return this.active;
  }

  private finish(active: ActiveTouch): void {
    if (this.active === active) this.active = null;
    this.clearMoveTimer(active);
    active.pendingMove = null;
  }

  private clearMoveTimer(active: ActiveTouch): void {
    if (active.moveFlushTimer !== null) clearTimeout(active.moveFlushTimer);
    active.moveFlushTimer = null;
  }

  private flushLatestMove(): void {
    const active = this.active;
    if (
      !active ||
      this.disposed ||
      this.failed ||
      !active.pendingMove ||
      active.moveFlushTimer !== null ||
      this.inFlightMoves >= this.maxInFlightMoves
    ) {
      return;
    }

    const point = active.pendingMove;
    active.pendingMove = null;
    this.inFlightMoves += 1;
    this.dispatch(this.input("move", point), () => {
      this.inFlightMoves = Math.max(0, this.inFlightMoves - 1);
      this.flushLatestMove();
    });
  }

  private dispatch(input: TouchInput, settled?: () => void): void {
    let request: Promise<void>;
    try {
      request = Promise.resolve(this.send(input));
    } catch (error) {
      this.fail(error);
      settled?.();
      return;
    }
    void request.then(
      () => settled?.(),
      (error) => {
        this.fail(error);
        settled?.();
      },
    );
  }

  private fail(error: unknown): void {
    if (this.disposed || this.failed) return;
    this.failed = true;
    const active = this.active;
    if (active) this.finish(active);
    this.onFailure(error);
  }

  private input(phase: TouchInput["phase"], point: SingleTouchPoint): TouchInput {
    return { kind: "touch", phase, x: point.x, y: point.y };
  }
}
