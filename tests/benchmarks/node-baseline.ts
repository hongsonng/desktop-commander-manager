import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { summarize } from "./metrics.js";
import { getBenchmarkCounts, getBenchmarkEnvironment } from "./benchmark-config.js";
import { IsolatedManagerInstance } from "./fixture-manager-host.js";

async function main() {
  const isQuick =
    process.argv.some((arg) => arg.includes("quick")) ||
    process.env.QUICK === "true";
  const counts = getBenchmarkCounts(isQuick);
  const env = getBenchmarkEnvironment();

  console.log(`\n========================================`);
  console.log(`Starting Node.js Manager Baseline Benchmark`);
  console.log(`Mode: ${isQuick ? "QUICK SMOKE" : "FULL BASELINE"}`);
  console.log(`Target commit: ${env.commitSha}`);
  console.log(`========================================\n`);

  // 1. Cold start & RSS benchmarks
  console.log(`[1/5] Measuring Cold Starts (${counts.coldStarts} runs)...`);
  const coldStartDurations: number[] = [];
  const rssSamples: number[] = [];

  for (let i = 0; i < counts.coldStarts; i++) {
    const start = performance.now();
    const instance = new IsolatedManagerInstance();
    await instance.start();
    const duration = performance.now() - start;
    coldStartDurations.push(duration);

    const mem = process.memoryUsage();
    rssSamples.push(mem.rss);

    await instance.close();
  }

  // 2. Persistent instance for tools/list and tools/call
  console.log(`[2/5] Measuring tools/list (${counts.toolsList} calls)...`);
  const activeInstance = new IsolatedManagerInstance();
  const { mcpUrl, managementUrl } = await activeInstance.start();

  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  const client = new Client({ name: "benchmark-client", version: "1.0.0" });
  await client.connect(transport);

  const toolsListDurations: number[] = [];
  for (let i = 0; i < counts.toolsList; i++) {
    const start = performance.now();
    await client.listTools();
    toolsListDurations.push(performance.now() - start);
  }

  console.log(`[3/5] Measuring tools/call (${counts.toolsCall} calls)...`);
  const toolsCallDurations: number[] = [];
  for (let i = 0; i < counts.toolsCall; i++) {
    const start = performance.now();
    await client.callTool({
      name: "identify",
      arguments: {},
      _meta: { "openai/session": `bench-session-${i % 10}` } as never,
    });
    toolsCallDurations.push(performance.now() - start);
  }

  // 3. Worker restart latency via management API
  console.log(`[4/5] Measuring Worker Restart Cycles (${counts.workerRestarts} runs)...`);
  const workerRestartDurations: number[] = [];
  for (let i = 0; i < counts.workerRestarts; i++) {
    const start = performance.now();
    const res = await fetch(`${managementUrl}/api/workers/worker-1/restart`, {
      method: "POST",
    });
    if (res.status !== 200) {
      throw new Error(`Worker restart returned status ${res.status}`);
    }
    workerRestartDurations.push(performance.now() - start);
  }

  await client.close();
  await activeInstance.close();

  // 4. Crash and recovery cycles
  console.log(`[5/5] Measuring Manager Recovery Cycles (${counts.crashRecovery} runs)...`);
  const recoveryDurations: number[] = [];
  for (let i = 0; i < counts.crashRecovery; i++) {
    const recInstance = new IsolatedManagerInstance();
    const { mcpUrl: recUrl } = await recInstance.start();
    const recClient = new Client({ name: "bench-rec-client", version: "1.0.0" });
    await recClient.connect(new StreamableHTTPClientTransport(new URL(recUrl)));

    await recClient.callTool({
      name: "identify",
      arguments: {},
      _meta: { "openai/session": "bench-crash" } as never,
    });

    const start = performance.now();
    recInstance.factory.crash("worker-1");
    // Wait for crash detection to mark worker DEGRADED
    const deadline = performance.now() + 2000;
    while (performance.now() < deadline) {
      if (recInstance.runtime!.database.workers.getWorker("worker-1")?.status === "DEGRADED") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    // Call tool again to trigger and measure recovery
    await recClient.callTool({
      name: "identify",
      arguments: {},
      _meta: { "openai/session": "bench-crash" } as never,
    });
    recoveryDurations.push(performance.now() - start);

    await recClient.close();
    await recInstance.close();
  }

  const results = {
    metadata: env,
    mode: isQuick ? "quick" : "full",
    counts,
    benchmarks: {
      coldStartMs: {
        summary: summarize(coldStartDurations),
        samples: coldStartDurations,
      },
      managerRssBytes: {
        summary: summarize(rssSamples),
        samples: rssSamples,
      },
      toolsListLatencyMs: {
        summary: summarize(toolsListDurations),
        samples: toolsListDurations,
      },
      toolsCallLatencyMs: {
        summary: summarize(toolsCallDurations),
        samples: toolsCallDurations,
      },
      workerRestartLatencyMs: {
        summary: summarize(workerRestartDurations),
        samples: workerRestartDurations,
      },
      crashRecoveryLatencyMs: {
        summary: summarize(recoveryDurations),
        samples: recoveryDurations,
      },
    },
  };

  const outputDir = join(process.cwd(), "benchmarks", "results");
  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, "node-baseline.json");
  writeFileSync(outputPath, JSON.stringify(results, null, 2), "utf-8");

  console.log(`\n========================================`);
  console.log(`Benchmark completed successfully!`);
  console.log(`Results saved to: ${outputPath}`);
  console.log(`Cold Start p95: ${results.benchmarks.coldStartMs.summary.p95.toFixed(2)} ms`);
  console.log(
    `Manager RSS median: ${(results.benchmarks.managerRssBytes.summary.median / (1024 * 1024)).toFixed(2)} MB`,
  );
  console.log(`Tools List p95: ${results.benchmarks.toolsListLatencyMs.summary.p95.toFixed(2)} ms`);
  console.log(`Tools Call p95: ${results.benchmarks.toolsCallLatencyMs.summary.p95.toFixed(2)} ms`);
  console.log(
    `Worker Restart p95: ${results.benchmarks.workerRestartLatencyMs.summary.p95.toFixed(2)} ms`,
  );
  console.log(
    `Crash Recovery p95: ${results.benchmarks.crashRecoveryLatencyMs.summary.p95.toFixed(2)} ms`,
  );
  console.log(`========================================\n`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
