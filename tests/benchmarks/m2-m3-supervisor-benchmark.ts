import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { summarize } from './metrics.js'
import { getBenchmarkEnvironment } from './benchmark-config.js'
import { startManager, type ManagerRuntime } from '../../apps/server/src/main.js'

async function connect(url: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url))
  const client = new Client({ name: 'm2-m3-benchmark-client', version: '1.0.0' })
  await client.connect(transport)
  return client
}

async function waitForWorkerReady(
  runtime: ManagerRuntime,
  workerId: string,
  initialPid?: number,
  timeoutMs = 5000,
): Promise<{ durationMs: number; newPid: number }> {
  const start = performance.now()
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const worker = runtime.database.workers.getWorker(workerId)
    if (
      worker &&
      worker.status === 'READY' &&
      worker.pid &&
      (!initialPid || worker.pid !== initialPid)
    ) {
      return { durationMs: performance.now() - start, newPid: worker.pid }
    }
    await new Promise((res) => setTimeout(res, 10))
  }
  throw new Error(`Worker ${workerId} failed to recover to READY within ${timeoutMs}ms`)
}

async function main() {
  const isQuick =
    process.argv.some((arg) => arg.includes('quick')) ||
    process.env.QUICK === 'true'
  const warmSamples = isQuick ? 5 : 10
  const harnessSamples = isQuick ? 10 : 25
  const toolCallSamples = isQuick ? 50 : 200
  const env = getBenchmarkEnvironment()

  console.log(`\n========================================`)
  console.log(`Starting M2-M3 Rust Worker Supervisor Benchmark`)
  console.log(`Mode: ${isQuick ? 'QUICK SMOKE' : 'FULL GATE EVALUATION'}`)
  console.log(`Warm worker samples: ${warmSamples}`)
  console.log(`Harness recovery samples: ${harnessSamples}`)
  console.log(`Tool call samples: ${toolCallSamples}`)
  console.log(`Target commit: ${env.commitSha}`)
  console.log(`========================================\n`)

  const releaseExe = resolve(process.cwd(), 'target', 'release', 'dcm-manager.exe')
  const debugExe = resolve(process.cwd(), 'target', 'debug', 'dcm-manager.exe')
  const exePath = existsSync(releaseExe) ? releaseExe : debugExe

  if (!existsSync(exePath)) {
    throw new Error(`dcm-manager.exe not found at ${exePath}. Run cargo build --release first.`)
  }

  const fakeScript = resolve('tests/fakes/fake-mcp-worker.mjs')

  // 1. Warm Worker Crash Recovery Gate Test (Real Desktop Commander Worker)
  console.log(`[1/3] Benchmarking Warm Worker Crash Recovery (Real Desktop Commander, ${warmSamples} cycles)...`)
  delete process.env.DCM_WORKER_COMMAND
  delete process.env.DCM_WORKER_ARGS
  const warmRecoveryDurations: number[] = []

  for (let i = 0; i < warmSamples; i++) {
    const root = mkdtempSync(join(tmpdir(), 'dcm-bench-warm-'))
    process.env.DCM_SUPERVISOR_MUTEX_NAME = `Local\\DesktopCommanderManager.BenchWarm.${process.pid}.${i}`
    const runtime = await startManager({
      databasePath: join(root, 'manager.db'),
      runtimeRoot: join(root, 'workers'),
      mcpPort: 0,
      managementPort: 0,
      workerOwner: 'rust',
      platformOwner: 'rust',
      nativeSidecarPath: exePath,
    })

    const client = await connect(runtime.mcpUrl)

    try {
      const worker = runtime.database.workers.getWorker('worker-1')
      if (!worker || !worker.pid) throw new Error('worker-1 not started')
      const initialPid = worker.pid

      // Pre-warm session on worker-1
      await client.callTool({
        name: 'get_config',
        arguments: {},
        _meta: { 'openai/session': `bench-warm-${i}` } as never,
      })

      // Crash worker
      const start = performance.now()
      process.kill(initialPid)

      // Wait for Rust supervisor to recover worker-1 to READY
      await waitForWorkerReady(runtime, 'worker-1', initialPid)
      const recoveryDuration = performance.now() - start
      warmRecoveryDurations.push(recoveryDuration)

      // Verify tool call immediately succeeds
      const callRes = await client.callTool({
        name: 'get_config',
        arguments: {},
        _meta: { 'openai/session': `bench-warm-${i}` } as never,
      })
      if (callRes.isError) throw new Error('Tool call returned error after warm recovery')
    } finally {
      await client.close()
      await runtime.close()
      rmSync(root, { recursive: true, force: true })
    }
  }

  const warmSummary = summarize(warmRecoveryDurations)
  console.log(
    `Rust Warm Worker Recovery: median=${warmSummary.median.toFixed(2)}ms, p95=${warmSummary.p95.toFixed(2)}ms, min=${warmSummary.min.toFixed(2)}ms`,
  )

  // 2. Supervisor Harness Crash Recovery Benchmark (Fake MCP Worker, Isolating Supervisor Overhead)
  console.log(`[2/3] Benchmarking Supervisor Overhead with Benchmark Harness (${harnessSamples} cycles)...`)
  process.env.DCM_WORKER_COMMAND = process.execPath
  process.env.DCM_WORKER_ARGS = JSON.stringify([fakeScript])
  const harnessRecoveryDurations: number[] = []

  for (let i = 0; i < harnessSamples; i++) {
    const root = mkdtempSync(join(tmpdir(), 'dcm-bench-harness-'))
    process.env.DCM_SUPERVISOR_MUTEX_NAME = `Local\\DesktopCommanderManager.BenchHarness.${process.pid}.${i}`
    const runtime = await startManager({
      databasePath: join(root, 'manager.db'),
      runtimeRoot: join(root, 'workers'),
      mcpPort: 0,
      managementPort: 0,
      workerOwner: 'rust',
      platformOwner: 'rust',
      nativeSidecarPath: exePath,
    })

    const client = await connect(runtime.mcpUrl)

    try {
      const worker = runtime.database.workers.getWorker('worker-1')
      if (!worker || !worker.pid) throw new Error('worker-1 not started in harness')
      const initialPid = worker.pid

      // Pre-warm session
      await client.callTool({
        name: 'identify',
        arguments: {},
        _meta: { 'openai/session': `bench-harness-${i}` } as never,
      })

      // Crash worker
      const start = performance.now()
      process.kill(initialPid)

      // Wait for Rust supervisor to recover worker-1 to READY
      await waitForWorkerReady(runtime, 'worker-1', initialPid)
      const recoveryDuration = performance.now() - start
      harnessRecoveryDurations.push(recoveryDuration)

      // Verify tool call
      const callRes = await client.callTool({
        name: 'identify',
        arguments: {},
        _meta: { 'openai/session': `bench-harness-${i}` } as never,
      })
      if (callRes.isError) throw new Error('Identify tool call returned error after harness recovery')
    } finally {
      await client.close()
      await runtime.close()
      rmSync(root, { recursive: true, force: true })
    }
  }

  const harnessSummary = summarize(harnessRecoveryDurations)
  console.log(
    `Rust Supervisor Harness Recovery: median=${harnessSummary.median.toFixed(2)}ms, p95=${harnessSummary.p95.toFixed(2)}ms, min=${harnessSummary.min.toFixed(2)}ms`,
  )

  // 3. Routing Overhead & Tool Latency Benchmark
  console.log(`[3/3] Measuring Routing Overhead on Rust Supervisor (${toolCallSamples} calls)...`)
  const root = mkdtempSync(join(tmpdir(), 'dcm-bench-routing-'))
  process.env.DCM_SUPERVISOR_MUTEX_NAME = `Local\\DesktopCommanderManager.BenchRouting.${process.pid}`
  const routingRuntime = await startManager({
    databasePath: join(root, 'manager.db'),
    runtimeRoot: join(root, 'workers'),
    mcpPort: 0,
    managementPort: 0,
    workerOwner: 'rust',
    platformOwner: 'rust',
    nativeSidecarPath: exePath,
  })

  const client = await connect(routingRuntime.mcpUrl)
  const listToolsDurations: number[] = []
  const callToolDurations: number[] = []

  for (let i = 0; i < toolCallSamples; i++) {
    const startList = performance.now()
    await client.listTools()
    listToolsDurations.push(performance.now() - startList)

    const startCall = performance.now()
    await client.callTool({
      name: 'identify',
      arguments: {},
      _meta: { 'openai/session': `bench-route-${i % 5}` } as never,
    })
    callToolDurations.push(performance.now() - startCall)
  }

  await client.close()
  await routingRuntime.close()
  rmSync(root, { recursive: true, force: true })

  // Clean up env overrides
  delete process.env.DCM_WORKER_COMMAND
  delete process.env.DCM_WORKER_ARGS

  const listSummary = summarize(listToolsDurations)
  const callSummary = summarize(callToolDurations)
  console.log(
    `tools/list latency: median=${listSummary.median.toFixed(2)}ms, p95=${listSummary.p95.toFixed(2)}ms, p99=${listSummary.p99.toFixed(2)}ms`,
  )
  console.log(
    `tools/call latency: median=${callSummary.median.toFixed(2)}ms, p95=${callSummary.p95.toFixed(2)}ms, p99=${callSummary.p99.toFixed(2)}ms`,
  )

  // 4. Gate Evaluation against Node Baseline (2026-10-07-node-baseline.md)
  // Baseline values:
  // Node crash recovery median: 194.20ms
  // Node tools/call p95: 30.10ms, p99: 38.65ms
  const nodeBaselineRecoveryMedian = 194.20
  const nodeBaselineCallP95 = 30.10
  const nodeBaselineCallP99 = 38.65

  const recoveryImprovementMedian =
    ((nodeBaselineRecoveryMedian - harnessSummary.median) / nodeBaselineRecoveryMedian) * 100
  const warmWorkerPass = warmSummary.p95 <= 5000
  const recoveryGatePass = recoveryImprovementMedian >= 30 && warmWorkerPass

  const routingP95Regression = ((callSummary.p95 - nodeBaselineCallP95) / nodeBaselineCallP95) * 100
  const routingP99Regression = ((callSummary.p99 - nodeBaselineCallP99) / nodeBaselineCallP99) * 100
  const routingP95Pass = routingP95Regression <= 5
  const routingP99Pass = routingP99Regression <= 10
  const routingGatePass = routingP95Pass && routingP99Pass

  console.log(`\n========================================`)
  console.log(`M2-M3 PROMOTION GATES EVALUATION:`)
  console.log(`----------------------------------------`)
  console.log(`1. Warm Worker Crash Recovery (p95 <= 5000ms):`)
  console.log(`   Measured p95: ${warmSummary.p95.toFixed(2)}ms -> ${warmWorkerPass ? 'PASS' : 'FAIL'}`)
  console.log(`2. Supervisor Recovery Median Improvement (target >= 30%):`)
  console.log(
    `   Node baseline: ${nodeBaselineRecoveryMedian}ms -> Rust measured: ${harnessSummary.median.toFixed(2)}ms`,
  )
  console.log(
    `   Improvement: ${recoveryImprovementMedian.toFixed(2)}% -> ${recoveryImprovementMedian >= 30 ? 'PASS' : 'FAIL'}`,
  )
  console.log(`3. Routing Overhead p95 Regression (target <= 5%):`)
  console.log(
    `   Baseline p95: ${nodeBaselineCallP95}ms -> Rust measured: ${callSummary.p95.toFixed(2)}ms (regression: ${routingP95Regression.toFixed(2)}%) -> ${routingP95Pass ? 'PASS' : 'INVESTIGATE'}`,
  )
  console.log(`4. Routing Overhead p99 Regression (target <= 10%):`)
  console.log(
    `   Baseline p99: ${nodeBaselineCallP99}ms -> Rust measured: ${callSummary.p99.toFixed(2)}ms (regression: ${routingP99Regression.toFixed(2)}%) -> ${routingP99Pass ? 'PASS' : 'INVESTIGATE'}`,
  )
  console.log(`========================================\n`)

  const report = {
    env,
    timestamp: new Date().toISOString(),
    warmRecovery: warmSummary,
    harnessRecovery: harnessSummary,
    routing: {
      listTools: listSummary,
      callTool: callSummary,
    },
    gates: {
      warmWorkerPass,
      recoveryMedianImprovementPercent: recoveryImprovementMedian,
      recoveryGatePass,
      routingP95RegressionPercent: routingP95Regression,
      routingP99RegressionPercent: routingP99Regression,
      routingGatePass,
    },
  }

  mkdirSync(join(process.cwd(), 'docs', 'benchmarks'), { recursive: true })
  const reportPath = join(
    process.cwd(),
    'docs',
    'benchmarks',
    '2026-10-10-m2-m3-worker-supervisor.json',
  )
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(`Saved benchmark data to ${reportPath}\n`)
}

main().catch((err) => {
  console.error('Benchmark failed:', err)
  process.exit(1)
})
