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
/** An open circuit heals on its own; a permanently open one would need an operator to notice. */
export const DEFAULT_CIRCUIT_COOLDOWN_MS = 60_000;
/** Bounds the per-installation registry so a stream of tenants cannot grow it without limit. */
export const MAX_TRACKED_LIMITERS = 200;

export type RequestLimiterOptions = {
  maxRequests?: number;
  windowMs?: number;
  maxConcurrent?: number;
  circuitFailureThreshold?: number;
  circuitCooldownMs?: number;
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
  private readonly circuitCooldownMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly recent: number[] = [];
  private active = 0;
  private queue: Array<() => void> = [];
  private pausedUntilMs = 0;
  private consecutiveFailures = 0;
  private circuitOpenUntilMs = 0;

  constructor({
    maxRequests = DEFAULT_LIMITER_MAX_REQUESTS,
    windowMs = DEFAULT_LIMITER_WINDOW_MS,
    maxConcurrent = DEFAULT_LIMITER_MAX_CONCURRENT,
    circuitFailureThreshold = DEFAULT_CIRCUIT_FAILURE_THRESHOLD,
    circuitCooldownMs = DEFAULT_CIRCUIT_COOLDOWN_MS,
    now = Date.now,
    sleep = defaultSleep,
  }: RequestLimiterOptions = {}) {
    this.maxRequests = assertBound(maxRequests, IKAS_DOCUMENTED_REQUESTS_PER_WINDOW);
    this.windowMs = assertBound(windowMs, 60_000);
    this.maxConcurrent = assertBound(maxConcurrent, 8);
    this.circuitFailureThreshold = assertBound(circuitFailureThreshold, 100);
    this.circuitCooldownMs = assertBound(circuitCooldownMs, 10 * 60_000);
    this.now = now;
    this.sleep = sleep;
  }

  /**
   * Opened by repeated upstream failures and closed again by time. Left permanently open it would
   * refuse every later correction until someone restarted the process, which is a worse outage
   * than the one it protects against.
   */
  get isCircuitOpen() {
    return this.now() < this.circuitOpenUntilMs;
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
    if (this.consecutiveFailures >= this.circuitFailureThreshold) {
      this.circuitOpenUntilMs = this.now() + this.circuitCooldownMs;
    }
  }

  recordSuccess() {
    this.consecutiveFailures = 0;
    this.circuitOpenUntilMs = 0;
  }

  reset() {
    this.circuitOpenUntilMs = 0;
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
    try {
      for (let wait = this.waitMs(); wait > 0; wait = this.waitMs()) {
        await this.sleep(wait);
      }
    } catch (error) {
      // A rejected sleep must not strand the slot, or the limiter wedges for the process lifetime.
      this.release();
      throw error;
    }
    this.recent.push(this.now());
  }

  private release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.isCircuitOpen) throw new IkasCircuitOpenError();
    await this.acquire();
    try {
      if (this.isCircuitOpen) throw new IkasCircuitOpenError();
      return await task();
    } finally {
      this.release();
    }
  }
}

const limiters = new Map<string, IkasRequestLimiter>();

/**
 * One limiter per installation, because ikas rate-limits and blocks per store: a global circuit
 * would let one merchant's outage refuse every other merchant's corrections, and a global pause
 * would slow stores that are nowhere near their own ceiling. It is still shared *within* an
 * installation, so a bulk batch and a single confirmed correction cannot exceed the ceiling
 * together.
 */
export function sharedIkasRequestLimiter(installationKey = "default"): IkasRequestLimiter {
  const existing = limiters.get(installationKey);
  if (existing) return existing;

  // Oldest-first eviction; an evicted limiter only loses its window history, never correctness.
  if (limiters.size >= MAX_TRACKED_LIMITERS) {
    const oldest = limiters.keys().next().value;
    if (oldest !== undefined) limiters.delete(oldest);
  }
  const limiter = new IkasRequestLimiter();
  limiters.set(installationKey, limiter);
  return limiter;
}

export function resetSharedIkasRequestLimiterForTests() {
  limiters.clear();
}
