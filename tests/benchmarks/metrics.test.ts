import { describe, expect, it } from "vitest";
import { percentile, summarize } from "./metrics.js";

describe("benchmark metrics", () => {
  it("returns deterministic nearest-rank percentiles for sorted and unsorted samples", () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const unsorted = [100, 20, 90, 10, 50, 70, 30, 80, 40, 60];
    const originalUnsorted = [...unsorted];

    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(100);
    expect(percentile(sorted, 99)).toBe(100);

    expect(percentile(unsorted, 50)).toBe(50);
    expect(percentile(unsorted, 95)).toBe(100);
    expect(percentile(unsorted, 99)).toBe(100);

    // Verify input array is not mutated
    expect(unsorted).toEqual(originalUnsorted);
  });

  it("summarizes empty input as an explicit error", () => {
    expect(() => summarize([])).toThrowError("Cannot summarize empty samples");
  });

  it("reports count/min/median/p95/p99/max/mean", () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const summary = summarize(samples);

    expect(summary).toEqual({
      count: 10,
      min: 10,
      median: 50,
      p95: 100,
      p99: 100,
      max: 100,
      mean: 55,
    });
  });
});
