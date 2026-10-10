import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { summarize, type BenchmarkSummary } from './metrics.js'
import { getBenchmarkEnvironment } from './benchmark-config.js'
import { startManager, type ManagerRuntime } from '../../apps/server/src/main.js'

async function rpc(url: string, method: string, id: number, params: Record<string, unknown>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  if (!res.ok) {
    throw new Error(`RPC failed HTTP ${res.status}: ${await res.text()}`)
  }
  return res.json() as Promise<Record<string, any>>
}

interface BenchmarkResults {
  nodeRouting: BenchmarkSummary
  rustRouting: BenchmarkSummary
  nodeListTools: BenchmarkSummary
  rustListTools: BenchmarkSummary
  nodeManagementApi: BenchmarkSummary
  rustManagementApi: BenchmarkSummary
  concurrencyPass: boolean
}

async function runBenchmarkForOwner(
  stateOwner: 'node' | 'rust',
  exePath: string,
  samples: number,
): Promise<{
  routingSamples: number[]
  listToolsSamples: number[]
  managementSamples: number[]
}> {
  const root = mkdtempSync(join(tmpdir(), `dcm-bench-m4-${stateOwner}-`))
  process.env.DCM_SUPERVISOR_MUTEX_NAME = `Local\\DesktopCommanderManager.BenchM4.${stateOwner}.${process.pid}`

  const fakeScript = resolve('tests/fakes/fake-mcp-worker.mjs')
  process.env.DCM_WORKER_COMMAND = process.execPath
  process.env.DCM_WORKER_ARGS = JSON.stringify([fakeScript])

  const runtime: ManagerRuntime = await startManager({
    databasePath: join(root, 'manager.db'),
    runtimeRoot: join(root, 'workers'),
    mcpPort: 0,
    managementPort: 0,
    platformOwner: 'rust',
    workerOwner: 'rust',
    stateOwner,
    nativeSidecarPath: exePath,
  })

  try {
    const envelope = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'openai/session': `bench-session-${stateOwner}`,
    }

    // Warm-up call
    await rpc(runtime.mcpUrl, 'tools/list', 1, { _meta: envelope })
    await rpc(runtime.mcpUrl, 'tools/call', 2, {
      name: 'identify',
      arguments: {},
      _meta: envelope,
    })

    // 1. tools/list latency samples
    const listToolsSamples: number[] = []
    for (let i = 0; i < samples; i++) {
      const start = performance.now()
      await rpc(runtime.mcpUrl, 'tools/list', 100 + i, { _meta: envelope })
      listToolsSamples.push(performance.now() - start)
    }

    // 2. tools/call routing latency samples
    const routingSamples: number[] = []
    for (let i = 0; i < samples; i++) {
      const start = performance.now()
      await rpc(runtime.mcpUrl, 'tools/call', 1000 + i, {
        name: 'identify',
        arguments: {},
        _meta: envelope,
      })
      routingSamples.push(performance.now() - start)
    }

    // 3. Management API health + workers latency
    const managementSamples: number[] = []
    for (let i = 0; i < samples; i++) {
      const start = performance.now()
      await fetch(`${runtime.managementUrl}/api/workers`)
      await fetch(`${runtime.managementUrl}/api/sessions`)
      managementSamples.push(performance.now() - start)
    }

    return { routingSamples, listToolsSamples, managementSamples }
  } finally {
    await runtime.close()
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

async function testConcurrencyStress(exePath: string): Promise<boolean> {
  const root = mkdtempSync(join(tmpdir(), 'dcm-bench-m4-concurrency-'))
  process.env.DCM_SUPERVISOR_MUTEX_NAME = `Local\\DesktopCommanderManager.BenchM4.Concurrency.${process.pid}`

  const fakeScript = resolve('tests/fakes/fake-mcp-worker.mjs')
  process.env.DCM_WORKER_COMMAND = process.execPath
  process.env.DCM_WORKER_ARGS = JSON.stringify([fakeScript])

  const runtime: ManagerRuntime = await startManager({
    databasePath: join(root, 'manager.db'),
    runtimeRoot: join(root, 'workers'),
    mcpPort: 0,
    managementPort: 0,
    platformOwner: 'rust',
    workerOwner: 'rust',
    stateOwner: 'rust',
    nativeSidecarPath: exePath,
  })

  try {
    const concurrentRequests = 30
    const promises = Array.from({ length: concurrentRequests }, async (_, i) => {
      const envelope = {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'openai/session': `concurrent-session-${i}`,
      }
      return rpc(runtime.mcpUrl, 'tools/call', 5000 + i, {
        name: 'identify',
        arguments: {},
        _meta: envelope,
      })
    })

    const results = await Promise.all(promises)
    const allSuccessful = results.every((r) => r.result !== undefined)

    const sessionsRes = await fetch(`${runtime.managementUrl}/api/sessions`)
    const sessions = (await sessionsRes.json()) as Array<{ sessionId: string; workerId: string }>

    const workersRes = await fetch(`${runtime.managementUrl}/api/workers`)
    const workers = (await workersRes.json()) as Array<{ id: string; activeSessionCount: number }>

    const totalWorkerSessions = workers.reduce((sum, w) => sum + w.activeSessionCount, 0)

    return allSuccessful && sessions.length === concurrentRequests && totalWorkerSessions === concurrentRequests
  } finally {
    await runtime.close()
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

async function main() {
  const releaseExe = resolve(process.cwd(), 'target', 'release', 'dcm-manager.exe')
  const debugExe = resolve(process.cwd(), 'target', 'debug', 'dcm-manager.exe')
  const exePath = existsSync(releaseExe) ? releaseExe : debugExe

  if (!existsSync(exePath)) {
    throw new Error(`dcm-manager.exe not found at ${exePath}. Run cargo build --release first.`)
  }

  const isQuick = process.argv.includes('--quick') || process.env.QUICK === 'true'
  const samples = isQuick ? 30 : 150

  console.log(`\n========================================`)
  console.log(`Starting M4 State & Router Benchmark`)
  console.log(`Mode: ${isQuick ? 'QUICK SMOKE' : 'FULL GATE EVALUATION'}`)
  console.log(`Samples per configuration: ${samples}`)
  console.log(`========================================\n`)

  console.log(`[1/3] Benchmarking stateOwner='node'...`)
  const nodeData = await runBenchmarkForOwner('node', exePath, samples)
  const nodeRouting = summarize(nodeData.routingSamples)
  const nodeListTools = summarize(nodeData.listToolsSamples)
  const nodeManagementApi = summarize(nodeData.managementSamples)

  console.log(`[2/3] Benchmarking stateOwner='rust'...`)
  const rustData = await runBenchmarkForOwner('rust', exePath, samples)
  const rustRouting = summarize(rustData.routingSamples)
  const rustListTools = summarize(rustData.listToolsSamples)
  const rustManagementApi = summarize(rustData.managementSamples)

  console.log(`[3/3] Running concurrent session stress test (30 concurrent sessions)...`)
  const concurrencyPass = await testConcurrencyStress(exePath)
  console.log(`Concurrency Stress Result: ${concurrencyPass ? 'PASSED' : 'FAILED'}`)

  // Calculate regression: (rust - node) / node * 100
  const routingP95Reg = ((rustRouting.p95 - nodeRouting.p95) / nodeRouting.p95) * 100
  const routingP99Reg = ((rustRouting.p99 - nodeRouting.p99) / nodeRouting.p99) * 100

  console.log(`\n========================================`)
  console.log(`GATE EVALUATION SUMMARY`)
  console.log(`========================================`)
  console.log(`Routing tools/call:`)
  console.log(`  Node p95: ${nodeRouting.p95.toFixed(2)} ms | Rust p95: ${rustRouting.p95.toFixed(2)} ms (Reg: ${routingP95Reg.toFixed(2)}%, Gate <= 5%)`)
  console.log(`  Node p99: ${nodeRouting.p99.toFixed(2)} ms | Rust p99: ${rustRouting.p99.toFixed(2)} ms (Reg: ${routingP99Reg.toFixed(2)}%, Gate <= 10%)`)
  console.log(`  Node Mean: ${nodeRouting.mean.toFixed(2)} ms | Rust Mean: ${rustRouting.mean.toFixed(2)} ms`)
  console.log(`\ntools/list:`)
  console.log(`  Node p95: ${nodeListTools.p95.toFixed(2)} ms | Rust p95: ${rustListTools.p95.toFixed(2)} ms`)
  console.log(`  Node Mean: ${nodeListTools.mean.toFixed(2)} ms | Rust Mean: ${rustListTools.mean.toFixed(2)} ms`)
  console.log(`\nManagement API (Workers + Sessions query):`)
  console.log(`  Node p95: ${nodeManagementApi.p95.toFixed(2)} ms | Rust p95: ${rustManagementApi.p95.toFixed(2)} ms`)
  console.log(`  Node Mean: ${nodeManagementApi.mean.toFixed(2)} ms | Rust Mean: ${rustManagementApi.mean.toFixed(2)} ms`)
  console.log(`\nConcurrency: ${concurrencyPass ? 'PASS' : 'FAIL'}`)

  const p95Pass = routingP95Reg <= 5
  const p99Pass = routingP99Reg <= 10
  const gatePass = p95Pass && p99Pass && concurrencyPass

  console.log(`\nOVERALL M4 GATE RESULT: ${gatePass ? 'PASS' : 'FAIL'}`)
  console.log(`========================================\n`)

  const outReport = {
    date: new Date().toISOString(),
    environment: getBenchmarkEnvironment(),
    samples,
    nodeRouting,
    rustRouting,
    routingP95Reg,
    routingP99Reg,
    nodeListTools,
    rustListTools,
    nodeManagementApi,
    rustManagementApi,
    concurrencyPass,
    gatePass,
  }

  const outPath = resolve(process.cwd(), 'docs/benchmarks/2026-10-07-m4-state-router.json')
  writeFileSync(outPath, JSON.stringify(outReport, null, 2))
  console.log(`Results saved to ${outPath}`)

  if (!gatePass) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Benchmark execution failed:', err)
  process.exit(1)
})
