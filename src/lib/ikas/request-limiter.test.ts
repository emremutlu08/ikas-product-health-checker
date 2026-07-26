import { describe, expect, it, vi } from "vitest";
import {
  IkasCircuitOpenError,
  IkasRequestLimiter,
  IKAS_DOCUMENTED_REQUESTS_PER_WINDOW,
  DEFAULT_LIMITER_MAX_REQUESTS,
  resetSharedIkasRequestLimiterForTests,
  sharedIkasRequestLimiter,
} from "./request-limiter";

function clock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("IkasRequestLimiter", () => {
  it("stays under the documented ikas ceiling by default", () => {
    expect(DEFAULT_LIMITER_MAX_REQUESTS).toBeLessThan(IKAS_DOCUMENTED_REQUESTS_PER_WINDOW);
  });

  it("waits instead of exceeding the window budget", async () => {
    const time = clock();
    const sleep = vi.fn(async (ms: number) => {
      time.advance(ms);
    });
    const limiter = new IkasRequestLimiter({
      maxRequests: 2,
      windowMs: 10_000,
      maxConcurrent: 1,
      now: time.now,
      sleep,
    });

    await limiter.run(async () => "a");
    await limiter.run(async () => "b");
    await limiter.run(async () => "c");

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]![0]).toBe(10_000);
  });

  it("pauses every caller after a 429 rather than retrying the failed one", async () => {
    const time = clock();
    const sleep = vi.fn(async (ms: number) => {
      time.advance(ms);
    });
    const limiter = new IkasRequestLimiter({ maxConcurrent: 1, now: time.now, sleep });

    limiter.pauseFor(5_000);
    await limiter.run(async () => "next");

    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it("opens a circuit after repeated failures and refuses further calls", async () => {
    const limiter = new IkasRequestLimiter({ circuitFailureThreshold: 2, sleep: async () => {} });

    limiter.recordFailure();
    expect(limiter.isCircuitOpen).toBe(false);
    limiter.recordFailure();

    expect(limiter.isCircuitOpen).toBe(true);
    await expect(limiter.run(async () => "x")).rejects.toBeInstanceOf(IkasCircuitOpenError);
  });

  it("closes the circuit again after its cooldown, without needing an operator", async () => {
    const time = clock();
    const limiter = new IkasRequestLimiter({
      circuitFailureThreshold: 1,
      circuitCooldownMs: 60_000,
      now: time.now,
      sleep: async () => {},
    });

    limiter.recordFailure();
    expect(limiter.isCircuitOpen).toBe(true);
    await expect(limiter.run(async () => "x")).rejects.toBeInstanceOf(IkasCircuitOpenError);

    time.advance(60_000);
    expect(limiter.isCircuitOpen).toBe(false);
    await expect(limiter.run(async () => "x")).resolves.toBe("x");
  });

  it("closes the circuit immediately on a success", () => {
    const limiter = new IkasRequestLimiter({ circuitFailureThreshold: 1, sleep: async () => {} });
    limiter.recordFailure();

    limiter.recordSuccess();

    expect(limiter.isCircuitOpen).toBe(false);
  });

  it("keeps each installation's circuit to itself", async () => {
    const first = sharedIkasRequestLimiter("app-1");
    const second = sharedIkasRequestLimiter("app-2");
    for (let attempt = 0; attempt < 10; attempt += 1) first.recordFailure();

    expect(first.isCircuitOpen).toBe(true);
    expect(second.isCircuitOpen).toBe(false);
    expect(sharedIkasRequestLimiter("app-1")).toBe(first);
    resetSharedIkasRequestLimiterForTests();
  });

  it("holds concurrency at the configured ceiling", async () => {
    const limiter = new IkasRequestLimiter({ maxConcurrent: 2, sleep: async () => {} });
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 6 }, () =>
        limiter.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await Promise.resolve();
          active -= 1;
        }),
      ),
    );

    expect(peak).toBe(2);
  });

  it("releases its slot when a task throws", async () => {
    const limiter = new IkasRequestLimiter({ maxConcurrent: 1, sleep: async () => {} });

    await expect(
      limiter.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(limiter.run(async () => "recovered")).resolves.toBe("recovered");
  });

  it("refuses a configuration above the documented ceiling", () => {
    expect(() => new IkasRequestLimiter({ maxRequests: 51 })).toThrow();
    expect(() => new IkasRequestLimiter({ maxConcurrent: 0 })).toThrow();
  });
});
