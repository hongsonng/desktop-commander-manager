import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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

interface StopReviewData {
  coldStartHealthMs: number[]
  coldStartWorkersMs: number[]
  nodeRssBytes: number[]
  rustRssBytes: number[]
  combinedRssBytes: number[]
  toolsListMs: number[]
  toolsCallMs: number[]
  resourceSnapshotMs: number[]
}

async function main() {
  const releaseExe = resolve(process.cwd(), 'target', 'release', 'dcm-manager.exe')
  const debugExe = resolve(process.cwd(), 'target', 'debug', 'dcm-manager.exe')
  const exePath = existsSync(releaseExe) ? releaseExe : debugExe

  if (!existsSync(exePath)) {
    throw new Error(`dcm-manager.exe not found at ${exePath}. Run cargo build --release first.`)
  }

  const isQuick = process.argv.includes('--quick') || process.env.QUICK === 'true'
  const startupSamples = isQuick ? 5 : 15
  const mcpSamples = isQuick ? 50 : 200

  console.log(`\n========================================`)
  console.log(`Starting M6 Stop-Condition Review Benchmark Matrix`)
  console.log(`Mode: ${isQuick ? 'QUICK SMOKE' : 'FULL STOP-REVIEW'}`)
  console.log(`Target executable: ${exePath}`)
  console.log(`========================================\n`)

  const fakeScript = resolve('tests/fakes/fake-mcp-worker.mjs')
  process.env.DCM_WORKER_COMMAND = process.execPath
  process.env.DCM_WORKER_ARGS = JSON.stringify([fakeScript])

  const coldStartHealth: number[] = []
  const coldStartWorkers: number[] = []
  const nodeRss: number[] = []
  const rustRss: number[] = []
  const combinedRss: number[] = []

  console.log(`[1/4] Measuring Cold Starts and Control-Plane Memory (${startupSamples} runs)...`)
  for (let i = 0; i < startupSamples; i++) {
    const root = mkdtempSync(join(tmpdir(), `dcm-bench-m6-startup-${i}-`))
    process.env.DCM_SUPERVISOR_MUTEX_NAME = `Local\\DesktopCommanderManager.BenchM6.Startup.${process.pid}.${i}`

    const start = performance.now()
    const runtime: ManagerRuntime = await startManager({
      databasePath: join(root, 'manager.db'),
      runtimeRoot: join(root, 'workers'),
      mcpPort: 0,
      managementPort: 0,
      platformOwner: 'rust',
      workerOwner: 'rust',
      stateOwner: 'rust',
      managementApiOwner: 'rust',
      nativeSidecarPath: exePath,
    })

    const healthTime = performance.now() - start
    coldStartHealth.push(healthTime)

    // Wait until workers are ready
    const workersReadyStart = performance.now()
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      const res = await fetch(`${runtime.managementUrl}/api/workers`)
      if (res.ok) {
        const workers = (await res.json()) as any[]
        if (workers.length >= 2 && workers.every((w) => w.status === 'READY')) {
          break
        }
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    const workersReadyTotal = performance.now() - start
    coldStartWorkers.push(workersReadyTotal)

    // Measure RSS
    const nRss = process.memoryUsage().rss
    const resources = (await (await fetch(`${runtime.managementUrl}/api/resources`)).json()) as any
    const mgrUsage = resources.items?.find((item: any) => item.id === 'manager')
    const rRss = mgrUsage?.memoryBytes ?? 0

    nodeRss.push(nRss)
    rustRss.push(rRss)
    combinedRss.push(nRss + rRss)

    await runtime.close()
    if (existsSync(root)) {
      rmSync(root, { recursive: true, force: true })
    }
  }

  console.log(`[2/4] Measuring MCP Overhead & Routing on Active Hybrid Runtime (${mcpSamples} calls)...`)
  const activeRoot = mkdtempSync(join(tmpdir(), `dcm-bench-m6-active-`))
  process.env.DCM_SUPERVISOR_MUTEX_NAME = `Local\\DesktopCommanderManager.BenchM6.Active.${process.pid}`

  const activeRuntime: ManagerRuntime = await startManager({
    databasePath: join(activeRoot, 'manager.db'),
    runtimeRoot: join(activeRoot, 'workers'),
    mcpPort: 0,
    managementPort: 0,
    platformOwner: 'rust',
    workerOwner: 'rust',
    stateOwner: 'rust',
    managementApiOwner: 'rust',
    nativeSidecarPath: exePath,
  })

  const envelope = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'openai/session': 'bench-session-m6',
  }

  // Warm-up call
  await rpc(activeRuntime.mcpUrl, 'tools/list', 1, { _meta: envelope })
  await rpc(activeRuntime.mcpUrl, 'tools/call', 2, {
    name: 'identify',
    arguments: {},
    _meta: envelope,
  })

  const toolsListSamples: number[] = []
  for (let i = 0; i < mcpSamples; i++) {
    const s = performance.now()
    await rpc(activeRuntime.mcpUrl, 'tools/list', 100 + i, { _meta: envelope })
    toolsListSamples.push(performance.now() - s)
  }

  const toolsCallSamples: number[] = []
  for (let i = 0; i < mcpSamples; i++) {
    const s = performance.now()
    await rpc(activeRuntime.mcpUrl, 'tools/call', 1000 + i, {
      name: 'identify',
      arguments: {},
      _meta: envelope,
    })
    toolsCallSamples.push(performance.now() - s)
  }

  console.log(`[3/4] Measuring Native Win32 Resource Sampling Latency...`)
  const resourceSnapshotSamples: number[] = []
  for (let i = 0; i < 50; i++) {
    const s = performance.now()
    const res = await fetch(`${activeRuntime.managementUrl}/api/resources`)
    if (!res.ok) throw new Error('Resource sampling failed')
    resourceSnapshotSamples.push(performance.now() - s)
  }

  console.log(`[4/4] Finalizing Summaries...`)
  await activeRuntime.close()
  if (existsSync(activeRoot)) {
    rmSync(activeRoot, { recursive: true, force: true })
  }

  const healthSum = summarize(coldStartHealth)
  const workersSum = summarize(coldStartWorkers)
  const nodeRssSum = summarize(nodeRss.map((b) => b / (1024 * 1024)))
  const rustRssSum = summarize(rustRss.map((b) => b / (1024 * 1024)))
  const combinedRssSum = summarize(combinedRss.map((b) => b / (1024 * 1024)))
  const listSum = summarize(toolsListSamples)
  const callSum = summarize(toolsCallSamples)
  const resourceSum = summarize(resourceSnapshotSamples)

  console.log(`\n========================================`)
  console.log(`M6 BENCHMARK MATRIX RESULTS`)
  console.log(`========================================`)
  console.log(`Cold Start -> Manager Health Ready:`)
  console.log(`  Median: ${healthSum.median.toFixed(2)} ms, p95: ${healthSum.p95.toFixed(2)} ms`)
  console.log(`Cold Start -> All Workers Ready:`)
  console.log(`  Median: ${workersSum.median.toFixed(2)} ms, p95: ${workersSum.p95.toFixed(2)} ms`)
  console.log(`Control-Plane Memory:`)
  console.log(`  Node Process RSS: ${nodeRssSum.median.toFixed(1)} MB`)
  console.log(`  Rust Sidecar RSS: ${rustRssSum.median.toFixed(1)} MB`)
  console.log(`  Combined RSS:     ${combinedRssSum.median.toFixed(1)} MB (p95: ${combinedRssSum.p95.toFixed(1)} MB)`)
  console.log(`MCP Synthetic Latencies:`)
  console.log(`  tools/list: p50=${listSum.median.toFixed(2)} ms, p95=${listSum.p95.toFixed(2)} ms, p99=${listSum.p99.toFixed(2)} ms`)
  console.log(`  tools/call: p50=${callSum.median.toFixed(2)} ms, p95=${callSum.p95.toFixed(2)} ms, p99=${callSum.p99.toFixed(2)} ms`)
  console.log(`Resource Snapshot:`)
  console.log(`  Median: ${resourceSum.median.toFixed(2)} ms, p95: ${resourceSum.p95.toFixed(2)} ms`)
  console.log(`========================================\n`)

  const payload = {
    timestamp: new Date().toISOString(),
    environment: getBenchmarkEnvironment(),
    coldStartHealth: healthSum,
    coldStartWorkers: workersSum,
    nodeRssMb: nodeRssSum,
    rustRssMb: rustRssSum,
    combinedRssMb: combinedRssSum,
    toolsList: listSum,
    toolsCall: callSum,
    resourceSnapshot: resourceSum,
  }

  process.stdout.write(`JSON_PAYLOAD_BEGIN\n${JSON.stringify(payload, null, 2)}\nJSON_PAYLOAD_END\n`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
