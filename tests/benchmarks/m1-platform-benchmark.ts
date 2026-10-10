import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { summarize } from './metrics.js'
import { getBenchmarkEnvironment } from './benchmark-config.js'
import { IsolatedManagerInstance } from './fixture-manager-host.js'
import {
  createPowerShellResourceCollector,
  createNativeResourceCollector,
} from '../../apps/server/src/resource-monitor.js'
import { NativeSidecarClient } from '../../apps/server/src/native-sidecar.js'

async function main() {
  const isQuick = process.argv.some((arg) => arg.includes('quick')) || process.env.QUICK === 'true'
  const sampleCount = isQuick ? 10 : 50
  const env = getBenchmarkEnvironment()

  console.log(`\n========================================`)
  console.log(`Starting M1 Platform Resource Sampling Benchmark`)
  console.log(`Mode: ${isQuick ? 'QUICK SMOKE' : 'FULL GATE EVALUATION'}`)
  console.log(`Samples: ${sampleCount}`)
  console.log(`Target commit: ${env.commitSha}`)
  console.log(`========================================\n`)

  const releaseExe = join(process.cwd(), 'target', 'release', 'dcm-manager.exe')
  const debugExe = join(process.cwd(), 'target', 'debug', 'dcm-manager.exe')
  const exePath = existsSync(releaseExe) ? releaseExe : debugExe

  if (!existsSync(exePath)) {
    throw new Error(`dcm-manager binary not found at ${exePath}. Run cargo build --release first.`)
  }

  // Start an isolated manager instance to have real running worker processes
  console.log('[1/4] Starting isolated manager with 2 workers...')
  const instance = new IsolatedManagerInstance()
  await instance.start()
  const managerPid = process.pid
  const workerPids = instance.runtime!.database.workers.listWorkers().flatMap((w) => w.pid ? [w.pid] : [])
  console.log(`Manager PID: ${managerPid}, Worker PIDs: ${workerPids.join(', ')}`)

  // 1. Benchmark Node PowerShell collector
  console.log(`[2/4] Measuring Node PowerShell collector (${sampleCount} runs)...`)
  const psCollector = createPowerShellResourceCollector()
  const psDurations: number[] = []

  for (let i = 0; i < sampleCount; i++) {
    const start = performance.now()
    await psCollector.collect(managerPid, workerPids)
    psDurations.push(performance.now() - start)
  }

  const psSummary = summarize(psDurations)
  console.log(`Node PowerShell latency: median=${psSummary.median.toFixed(2)}ms, p95=${psSummary.p95.toFixed(2)}ms, p99=${psSummary.p99.toFixed(2)}ms`)

  // 2. Benchmark Rust native collector
  console.log(`[3/4] Measuring Rust native collector (${sampleCount} runs)...`)
  const sidecarClient = await NativeSidecarClient.start(exePath)
  const rustCollector = createNativeResourceCollector(sidecarClient)
  const rustDurations: number[] = []

  for (let i = 0; i < sampleCount; i++) {
    const start = performance.now()
    await rustCollector.collect(managerPid, workerPids)
    rustDurations.push(performance.now() - start)
  }

  const rustSummary = summarize(rustDurations)
  console.log(`Rust native latency: median=${rustSummary.median.toFixed(2)}ms, p95=${rustSummary.p95.toFixed(2)}ms, p99=${rustSummary.p99.toFixed(2)}ms`)

  // 3. Shadow verification: compare structure and data
  console.log('[4/4] Verifying shadow output equivalence...')
  const nodeSample = await psCollector.collect(managerPid, workerPids)
  const rustSample = await rustCollector.collect(managerPid, workerPids)

  const managerCountMatch = nodeSample.manager.processCount === rustSample.manager.processCount
  const tunnelCountMatch = nodeSample.tunnel.processCount === rustSample.tunnel.processCount
  const workerCountMatch = nodeSample.workers.length === rustSample.workers.length

  console.log(`Process counts match: manager=${managerCountMatch}, tunnel=${tunnelCountMatch}, workers=${workerCountMatch}`)
  console.log(`Manager memory: Node=${(nodeSample.manager.memoryBytes / 1024 / 1024).toFixed(2)}MB, Rust=${(rustSample.manager.memoryBytes / 1024 / 1024).toFixed(2)}MB`)

  await sidecarClient.close()
  await instance.close()

  // Calculate speedup
  const p95ImprovementPercent = ((psSummary.p95 - rustSummary.p95) / psSummary.p95) * 100
  const medianImprovementPercent = ((psSummary.median - rustSummary.median) / psSummary.median) * 100

  console.log(`\n========================================`)
  console.log(`M1 GATE RESULTS:`)
  console.log(`p95 improvement: ${p95ImprovementPercent.toFixed(2)}% (Target: >= 70%)`)
  console.log(`median improvement: ${medianImprovementPercent.toFixed(2)}%`)
  console.log(`Gate passed: ${p95ImprovementPercent >= 70 ? 'YES (PASS)' : 'NO (FAIL)'}`)
  console.log(`========================================\n`)

  const results = {
    env,
    sampleCount,
    node: {
      medianMs: psSummary.median,
      p95Ms: psSummary.p95,
      p99Ms: psSummary.p99,
      minMs: psSummary.min,
      maxMs: psSummary.max,
    },
    rust: {
      medianMs: rustSummary.median,
      p95Ms: rustSummary.p95,
      p99Ms: rustSummary.p99,
      minMs: rustSummary.min,
      maxMs: rustSummary.max,
    },
    comparison: {
      p95ImprovementPercent,
      medianImprovementPercent,
      passedGate: p95ImprovementPercent >= 70,
      shadowEquivalence: {
        managerCountMatch,
        tunnelCountMatch,
        workerCountMatch,
      },
    },
  }

  const resultsDir = join(process.cwd(), 'benchmarks', 'results')
  mkdirSync(resultsDir, { recursive: true })
  writeFileSync(
    join(resultsDir, 'm1-platform.json'),
    JSON.stringify(results, null, 2),
    'utf8',
  )
  console.log(`Saved benchmark results to benchmarks/results/m1-platform.json`)
}

main().catch((err) => {
  console.error('Benchmark failed:', err)
  process.exit(1)
})
