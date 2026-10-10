export interface BenchmarkSummary {
  count: number;
  min: number;
  median: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) {
    throw new Error("Cannot calculate percentile of empty samples");
  }
  if (p < 0 || p > 100) {
    throw new Error(`Percentile must be between 0 and 100, got ${p}`);
  }

  const sorted = [...samples].sort((a, b) => a - b);
  // Nearest-rank method
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.max(0, Math.min(sorted.length - 1, rank - 1));
  return sorted[index];
}

export function summarize(samples: number[]): BenchmarkSummary {
  if (samples.length === 0) {
    throw new Error("Cannot summarize empty samples");
  }

  const count = samples.length;
  let min = samples[0];
  let max = samples[0];
  let sum = 0;

  for (const s of samples) {
    if (s < min) min = s;
    if (s > max) max = s;
    sum += s;
  }

  const mean = sum / count;
  const median = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const p99 = percentile(samples, 99);

  return {
    count,
    min,
    median,
    p95,
    p99,
    max,
    mean,
  };
}
