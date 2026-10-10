import { execFile } from 'node:child_process'
import { cpus, freemem, totalmem } from 'node:os'
import { promisify } from 'node:util'
import type { CapabilityOwner, NativeSidecarClient } from './native-sidecar.js'

const execFileAsync = promisify(execFile)

export interface ResourceProcessUsage {
  id: string
  label: string
  pid: number | null
  memoryBytes: number
  cpuPercent: number
  processCount: number
  status: 'running' | 'stopped'
}

export interface ResourceUsageSnapshot {
  available: boolean
  sampledAt: string
  total: { memoryBytes: number; cpuPercent: number }
  system: { memoryUsedBytes: number; totalMemoryBytes: number; cpuPercent: number }
  items: ResourceProcessUsage[]
  error?: string
}

export type RawUsage = {
  rootPid: number | null
  memoryBytes: number
  cpuSeconds: number
  processCount: number
}

export type RawSnapshot = {
  manager: RawUsage
  tunnel: RawUsage
  workers: RawUsage[]
}

export type WorkerPid = { id: string; name: string; pid: number | null }

export interface ResourceCollector {
  collect(managerPid: number, workerPids: number[]): Promise<RawSnapshot>
}

export interface ShadowComparisonRecord {
  sampledAt: string
  node: RawSnapshot
  rust: RawSnapshot
  match: {
    managerCountMatch: boolean
    tunnelCountMatch: boolean
    workerCountMatch: boolean
  }
}

export interface ResourceMonitorOptions {
  owner?: CapabilityOwner
  nodeCollector?: ResourceCollector
  rustCollector?: ResourceCollector
  onShadowComparison?: (comparison: ShadowComparisonRecord) => void
}

export interface ResourceMonitor {
  snapshot(): Promise<ResourceUsageSnapshot>
  close?(): Promise<void>
}

type CpuTicks = { idle: number; total: number }

function readSystemCpuTicks(): CpuTicks {
  let idle = 0
  let total = 0
  for (const cpu of cpus()) {
    idle += cpu.times.idle
    total += cpu.times.idle + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq
  }
  return { idle, total }
}

function percent(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10
}

function cpuDelta(current: number, previous: number | undefined, elapsedSeconds: number, logicalProcessors: number): number {
  if (previous === undefined || elapsedSeconds <= 0 || logicalProcessors <= 0) return 0
  return percent(((current - previous) / elapsedSeconds / logicalProcessors) * 100)
}

function createPowerShellScript(managerPid: number, workerPids: number[]): string {
  const roots = workerPids.join(',')
  return `
$ErrorActionPreference = 'SilentlyContinue'
$managerPid = ${managerPid}
$workerRoots = @(${roots})
$all = @(Get-CimInstance Win32_Process)

function Get-TreeIds([int]$root) {
  $seen = New-Object 'System.Collections.Generic.HashSet[int]'
  $queue = New-Object 'System.Collections.Generic.Queue[int]'
  $queue.Enqueue($root)
  while ($queue.Count -gt 0) {
    $id = $queue.Dequeue()
    if (-not $seen.Add($id)) { continue }
    foreach ($child in $all | Where-Object ParentProcessId -eq $id) { $queue.Enqueue([int]$child.ProcessId) }
  }
  return @($seen)
}

function Measure-Tree([int]$root) {
  if ($root -le 0) { return [pscustomobject]@{rootPid=$null;memoryBytes=0;cpuSeconds=0;processCount=0} }
  $ids = @(Get-TreeIds $root)
  $processes = @($ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
  $memory = ($processes | Measure-Object WorkingSet64 -Sum).Sum
  $cpu = ($processes | Measure-Object CPU -Sum).Sum
  return [pscustomobject]@{
    rootPid=$root
    memoryBytes=if($memory){[double]$memory}else{0}
    cpuSeconds=if($cpu){[double]$cpu}else{0}
    processCount=$processes.Count
  }
}

$managerProcess = @(Get-Process -Id $managerPid -ErrorAction SilentlyContinue)
$managerMemory = ($managerProcess | Measure-Object WorkingSet64 -Sum).Sum
$managerCpu = ($managerProcess | Measure-Object CPU -Sum).Sum
$manager = [pscustomobject]@{
  rootPid=if($managerProcess.Count -gt 0){$managerPid}else{$null}
  memoryBytes=if($managerMemory){[double]$managerMemory}else{0}
  cpuSeconds=if($managerCpu){[double]$managerCpu}else{0}
  processCount=$managerProcess.Count
}
$workers = @($workerRoots | Where-Object { $_ -gt 0 } | ForEach-Object { Measure-Tree $_ })
$tunnelRoots = @($all | Where-Object {
  $_.Name -eq 'tunnel-client.exe' -and $_.CommandLine -match '--profile\\s+desktop-commander-manager'
} | Select-Object -ExpandProperty ProcessId)

$tunnelIds = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($root in $tunnelRoots) { foreach ($id in @(Get-TreeIds ([int]$root))) { [void]$tunnelIds.Add([int]$id) } }
$tunnelProcesses = @($tunnelIds | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
$tunnelMemory = ($tunnelProcesses | Measure-Object WorkingSet64 -Sum).Sum
$tunnelCpu = ($tunnelProcesses | Measure-Object CPU -Sum).Sum
$tunnel = [pscustomobject]@{
  rootPid=if($tunnelRoots.Count -gt 0){[int]$tunnelRoots[0]}else{$null}
  memoryBytes=if($tunnelMemory){[double]$tunnelMemory}else{0}
  cpuSeconds=if($tunnelCpu){[double]$tunnelCpu}else{0}
  processCount=$tunnelProcesses.Count
}

[pscustomobject]@{manager=$manager;tunnel=$tunnel;workers=$workers} | ConvertTo-Json -Depth 5 -Compress
`
}

async function collectRawUsage(managerPid: number, workerPids: number[]): Promise<RawSnapshot> {
  if (process.platform !== 'win32') {
    return {
      manager: { rootPid: managerPid, memoryBytes: process.memoryUsage().rss, cpuSeconds: 0, processCount: 1 },
      tunnel: { rootPid: null, memoryBytes: 0, cpuSeconds: 0, processCount: 0 },
      workers: [],
    }
  }
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    createPowerShellScript(managerPid, workerPids),
  ], { windowsHide: true, maxBuffer: 1024 * 1024 })
  return JSON.parse(stdout.trim()) as RawSnapshot
}

export function createPowerShellResourceCollector(): ResourceCollector {
  return {
    async collect(managerPid: number, workerPids: number[]): Promise<RawSnapshot> {
      return collectRawUsage(managerPid, workerPids)
    },
  }
}

export function createNativeResourceCollector(client: NativeSidecarClient): ResourceCollector {
  return {
    async collect(managerPid: number, workerPids: number[]): Promise<RawSnapshot> {
      return client.snapshot({
        managerPid,
        workerPids,
        tunnelProfile: 'desktop-commander-manager',
      })
    },
  }
}

export function createResourceMonitor(
  getWorkers: () => WorkerPid[],
  options: ResourceMonitorOptions = {},
): ResourceMonitor {
  const previousCpu = new Map<string, number>()
  let previousAt = Date.now()
  let previousSystem = readSystemCpuTicks()

  const owner = options.owner ?? 'node'
  const nodeCollector = options.nodeCollector ?? createPowerShellResourceCollector()
  const rustCollector = options.rustCollector

  return {
    async snapshot(): Promise<ResourceUsageSnapshot> {
      const sampledAt = new Date().toISOString()
      const now = Date.now()
      const elapsedSeconds = Math.max((now - previousAt) / 1000, 0.001)
      const logicalProcessors = Math.max(cpus().length, 1)
      const workers = getWorkers()
      const workerPids = workers.flatMap((worker) => worker.pid ? [worker.pid] : [])

      try {
        let raw: RawSnapshot
        if (owner === 'rust') {
          if (!rustCollector) throw new Error('Rust collector is required when owner is "rust"')
          raw = await rustCollector.collect(process.pid, workerPids)
        } else if (owner === 'shadow') {
          raw = await nodeCollector.collect(process.pid, workerPids)
          if (rustCollector) {
            rustCollector.collect(process.pid, workerPids).then((rustRaw) => {
              if (options.onShadowComparison) {
                options.onShadowComparison({
                  sampledAt,
                  node: raw,
                  rust: rustRaw,
                  match: {
                    managerCountMatch: raw.manager.processCount === rustRaw.manager.processCount,
                    tunnelCountMatch: raw.tunnel.processCount === rustRaw.tunnel.processCount,
                    workerCountMatch: raw.workers.length === rustRaw.workers.length,
                  },
                })
              }
            }).catch(() => {
              // Shadow errors never impact the authoritative response
            })
          }
        } else {
          raw = await nodeCollector.collect(process.pid, workerPids)
        }

        const rawByPid = new Map(raw.workers.map((item) => [item.rootPid, item]))
        const items: ResourceProcessUsage[] = []

        const append = (id: string, label: string, usage: RawUsage, pid: number | null) => {
          const cpuPercent = cpuDelta(usage.cpuSeconds, previousCpu.get(id), elapsedSeconds, logicalProcessors)
          previousCpu.set(id, usage.cpuSeconds)
          items.push({
            id, label, pid,
            memoryBytes: Math.round(usage.memoryBytes),
            cpuPercent,
            processCount: usage.processCount,
            status: usage.processCount > 0 ? 'running' : 'stopped',
          })
        }

        append('manager', 'Manager', raw.manager, raw.manager.rootPid)
        append('tunnel', 'Secure MCP Tunnel', raw.tunnel, raw.tunnel.rootPid)
        for (const worker of workers) {
          const usage = worker.pid ? rawByPid.get(worker.pid) : undefined
          append(worker.id, worker.name, usage ?? { rootPid: worker.pid, memoryBytes: 0, cpuSeconds: 0, processCount: 0 }, worker.pid)
        }

        const currentSystem = readSystemCpuTicks()
        const systemTotalDelta = currentSystem.total - previousSystem.total
        const systemIdleDelta = currentSystem.idle - previousSystem.idle
        const systemCpuPercent = systemTotalDelta > 0 ? percent(((systemTotalDelta - systemIdleDelta) / systemTotalDelta) * 100) : 0
        previousSystem = currentSystem
        previousAt = now

        return {
          available: true,
          sampledAt,
          total: {
            memoryBytes: items.reduce((sum, item) => sum + item.memoryBytes, 0),
            cpuPercent: percent(items.reduce((sum, item) => sum + item.cpuPercent, 0)),
          },
          system: {
            memoryUsedBytes: totalmem() - freemem(),
            totalMemoryBytes: totalmem(),
            cpuPercent: systemCpuPercent,
          },
          items,
        }
      } catch (error) {
        previousAt = now
        return {
          available: false,
          sampledAt,
          total: { memoryBytes: process.memoryUsage().rss, cpuPercent: 0 },
          system: {
            memoryUsedBytes: totalmem() - freemem(),
            totalMemoryBytes: totalmem(),
            cpuPercent: 0,
          },
          items: [{
            id: 'manager',
            label: 'Manager',
            pid: process.pid,
            memoryBytes: process.memoryUsage().rss,
            cpuPercent: 0,
            processCount: 1,
            status: 'running',
          }],
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }
}
