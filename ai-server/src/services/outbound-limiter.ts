/**
 * Process-wide sliding-window cap on outbound requests to an outside service
 * (used for Wikimedia Commons). Each tryAcquire() that returns true counts as
 * one request. Timestamps older than the window are dropped, so memory is
 * bounded by maxRequests.
 */
export const OUTBOUND_LIMIT_WINDOW_MS = 60_000;

export class OutboundLimiter {
  private readonly stamps: number[] = [];

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number = OUTBOUND_LIMIT_WINDOW_MS,
    private readonly now: () => number = Date.now
  ) {}

  /** Returns true and records the request when under the cap, else false. */
  tryAcquire(): boolean {
    const nowMs = this.now();
    while (this.stamps.length > 0 && this.stamps[0] <= nowMs - this.windowMs) {
      this.stamps.shift();
    }
    if (this.stamps.length >= this.maxRequests) return false;
    this.stamps.push(nowMs);
    return true;
  }
}
