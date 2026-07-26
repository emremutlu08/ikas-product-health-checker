/**
 * The one place that decides how fast this app is allowed to talk to the ikas Admin API.
 *
 * ikas documents 50 requests per 10 seconds, and — more importantly — escalating hour-, day- and
 * multi-day blocks once the error rate stays high. The default ceiling here is deliberately well
 * under the documented limit: a health-checker that gets a merchant's store blocked is worse than
 * a slow one. A `429` pauses every queued caller rather than retrying the failed one, and repeated
 * failures open a circuit so a broken batch stops instead of burning the error budget.
 */

export const IKAS_DOCUMENTED_REQUESTS_PER_WINDOW = 50;
export const IKAS_DOCUMENTED_WINDOW_MS = 10_000;

export const DEFAULT_LIMITER_MAX_REQUESTS = 20;
export const DEFAULT_LIMITER_WINDOW_MS = IKAS_DOCUMENTED_WINDOW_MS;
export const DEFAULT_LIMITER_MAX_CONCURRENT = 2;
export const DEFAULT_RATE_LIMIT_PAUSE_MS = 10_000;
export const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 5;

export type RequestLimiterOptions = {
  maxRequests?: number;
  windowMs?: number;
  maxConcurrent?: number;
  circuitFailureThreshold?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export class IkasCircuitOpenError extends Error {
  readonly code = "IKAS_REQUEST_CIRCUIT_OPEN" as const;

  constructor() {
    super("IKAS_REQUEST_CIRCUIT_OPEN");
    this.name = "IkasCircuitOpenError";
  }
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function assertBound(value: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error("IKAS_REQUEST_LIMITER_INVALID");
  }
  return value;
}

export class IkasRequestLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly maxConcurrent: number;
  private readonly circuitFailureThreshold: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly recent: number[] = [];
  private active = 0;
  private queue: Array<() => void> = [];
  private pausedUntilMs = 0;
  private consecutiveFailures = 0;
  private circuitOpen = false;

  constructor({
    maxRequests = DEFAULT_LIMITER_MAX_REQUESTS,
    windowMs = DEFAULT_LIMITER_WINDOW_MS,
    maxConcurrent = DEFAULT_LIMITER_MAX_CONCURRENT,
    circuitFailureThreshold = DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
    now = Date.now,
    sleep = defaultSleep,
  }: RequestLimiterOptions = {}) {
    this.maxRequests = assertBound(maxRequests, IKAS_DOCUMENTED_REQUESTS_PER_WINDOW);
    this.windowMs = assertBound(windowMs, 60_000);
    this.maxConcurrent = assertBound(maxConcurrent, 8);
    this.circuitFailureThreshold = assertBound(circuitFailureThreshold, 100);
    this.now = now;
    this.sleep = sleep;
  }

  /** Opened by repeated upstream failures; only an explicit reset closes it again. */
  get isCircuitOpen() {
    return this.circuitOpen;
  }

  get pausedUntil() {
    return this.pausedUntilMs;
  }

  /** A `429` pauses the whole limiter. The caller that saw it is never retried automatically. */
  pauseFor(ms: number) {
    if (!Number.isSafeInteger(ms) || ms <= 0) return;
    this.pausedUntilMs = Math.max(this.pausedUntilMs, this.now() + ms);
  }

  recordFailure() {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.circuitFailureThreshold) this.circuitOpen = true;
  }

  recordSuccess() {
    this.consecutiveFailures = 0;
  }

  reset() {
    this.circuitOpen = false;
    this.consecutiveFailures = 0;
    this.pausedUntilMs = 0;
  }

  private prune() {
    const cutoff = this.now() - this.windowMs;
    while (this.recent.length > 0 && this.recent[0]! <= cutoff) this.recent.shift();
  }

  /** Milliseconds the next caller has to wait, or 0 when a slot is free right now. */
  private waitMs() {
    const pauseRemaining = this.pausedUntilMs - this.now();
    if (pauseRemaining > 0) return pauseRemaining;
    this.prune();
    if (this.recent.length < this.maxRequests) return 0;
    return Math.max(1, this.recent[0]! + this.windowMs - this.now());
  }

  private async acquire() {
    while (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    for (let wait = this.waitMs(); wait > 0; wait = this.waitMs()) {
      await this.sleep(wait);
    }
    this.recent.push(this.now());
  }

  private release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.circuitOpen) throw new IkasCircuitOpenError();
    await this.acquire();
    try {
      if (this.circuitOpen) throw new IkasCircuitOpenError();
      return await task();
    } finally {
      this.release();
    }
  }
}

let sharedLimiter: IkasRequestLimiter | undefined;

/** Shared so a bulk batch and a single confirmed correction cannot exceed the ceiling together. */
export function sharedIkasRequestLimiter(): IkasRequestLimiter {
  sharedLimiter ??= new IkasRequestLimiter();
  return sharedLimiter;
}

export function resetSharedIkasRequestLimiterForTests() {
  sharedLimiter = undefined;
}
