// The phase-2 heartbeat: an LLM call in flight re-reports its elapsed time
// every few seconds, which is the only way the chat surface can tell "slow"
// from "hung". Outside a browser host the helper is a no-op, so no test can
// leave a live timer behind.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  startHeartbeat,
  elapsedSeconds,
  formatSeconds,
  HEARTBEAT_INTERVAL_MS,
} from "../../src/progress";

const WINDOW_SHIM = globalThis as unknown as { window?: unknown };
const HOST = globalThis;

describe("progress helpers", () => {
  it("formats a duration and an elapsed timestamp", () => {
    expect(formatSeconds(9.4)).toBe("9s");
    expect(formatSeconds(0)).toBe("0s");
    expect(elapsedSeconds(Date.now() - 5000)).toBeCloseTo(5, 1);
    expect(HEARTBEAT_INTERVAL_MS).toBe(5000);
  });
});

describe("startHeartbeat", () => {
  beforeEach(() => {
    WINDOW_SHIM.window = HOST;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete WINDOW_SHIM.window;
  });

  it("ticks with elapsed seconds and stops on demand", () => {
    const ticks: number[] = [];
    const stop = startHeartbeat((seconds) => ticks.push(seconds));

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    stop();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);

    // Stopping is what keeps a finished call from reporting forever.
    expect(ticks).toEqual([5, 10, 15]);
  });

  it("is a no-op without a browser host (the node test environment)", () => {
    delete WINDOW_SHIM.window;
    const onTick = vi.fn();

    const stop = startHeartbeat(onTick);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);

    expect(onTick).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });
});
