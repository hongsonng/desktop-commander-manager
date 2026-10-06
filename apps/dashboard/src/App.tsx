import { useCallback, useEffect, useState } from 'react'
import {
  getConnectionInfo,
  getEvents,
  getHealth,
  getResources,
  getToolCalls,
  getSessions,
  getWorkers,
  workerAction,
} from './api'
import type { ConnectionInfo, EventView, HealthResponse, ResourceUsageView, SessionView, ToolCallView, WorkerAction, WorkerView } from './types'
import './styles.css'

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`
  return `${seconds}s`
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'â€”'
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString()
}

function formatBytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(value / 1024 ** 2)} MB`
}

function toolKind(name: string): 'READ' | 'WRITE' | 'COMMAND' | 'TOOL' {
  if (['start_process', 'interact_with_process', 'force_terminate', 'kill_process'].includes(name)) return 'COMMAND'
  if (/^(write_|edit_|create_|move_|set_|kill_)/.test(name)) return 'WRITE'
  if (/^(read_|get_|list_|start_search|get_more_search_results|stop_search)/.test(name)) return 'READ'
  return 'TOOL'
}

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [connectionInfo, setConnectionInfo] = useState<ConnectionInfo | null>(null)
  const [workers, setWorkers] = useState<WorkerView[]>([])
  const [resources, setResources] = useState<ResourceUsageView | null>(null)
  const [sessions, setSessions] = useState<SessionView[]>([])
  const [events, setEvents] = useState<EventView[]>([])
  const [toolCalls, setToolCalls] = useState<ToolCallView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [nextHealth, nextConnectionInfo, nextWorkers, nextResources, nextSessions, nextEvents, nextToolCalls] = await Promise.all([
        getHealth(), getConnectionInfo(), getWorkers(), getResources(), getSessions(), getEvents(), getToolCalls(),
      ])
      setHealth(nextHealth)
      setConnectionInfo(nextConnectionInfo)
      setWorkers(nextWorkers)
      setResources(nextResources)
      setSessions(nextSessions)
      setEvents(nextEvents)
      setToolCalls(nextToolCalls)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 2000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const act = async (workerId: string, action: WorkerAction) => {
    const key = `worker:${workerId}:${action}`
    setBusyAction(key)
    try { await workerAction(workerId, action); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusyAction(null) }
  }

  return <main className="shell">
    <header className="page-header">
      <div><p className="eyebrow">LOCAL CONTROL PLANE</p><h1>Desktop Commander Manager</h1></div>
      <div className={`health ${health?.status === 'ok' ? 'healthy' : ''}`}><span className="dot" />{health?.status ?? 'connecting'}</div>
    </header>

    {error && <div role="alert" className="alert"><strong>Connection error</strong><span>{error}</span><button onClick={() => void refresh()}>Retry</button></div>}

    <section className="panel connection-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">CHATGPT CONNECTION</p><h2>Direct local</h2></div>
        <span className="badge state-ready">{connectionInfo?.workerStrategy === 'sticky-failover' ? 'AUTO FAILOVER' : 'CONNECTING'}</span>
      </div>
      <div className="connection-path"><span>ChatGPT / Secure MCP Tunnel</span><strong>→</strong><code>{connectionInfo?.mcpUrl ?? 'http://127.0.0.1:8787/mcp'}</code><strong>→</strong><span>Local workers</span></div>
      <p className="hint">Configure the ChatGPT connector once. The manager keeps the MCP endpoint stable and routes sessions across local workers automatically.</p>
    </section>

    <section className="stats" aria-label="Manager summary">
      <article><span>Workers</span><strong>{workers.length}</strong></article>
      <article><span>Active sessions</span><strong>{sessions.length}</strong></article>
      <article><span>Uptime</span><strong>{health ? formatUptime(health.uptimeMs) : 'â€”'}</strong></article>
    </section>

    <section className="panel resource-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">SYSTEM RESOURCES</p><h2>Resource Usage</h2></div>
        <span className={`badge ${resources?.available ? 'live-badge' : 'state-degraded'}`}>{resources?.available ? 'LIVE · 2s' : 'LIMITED'}</span>
      </div>
      <div className="resource-summary">
        <article><span>Stack RAM</span><strong>{resources ? formatBytes(resources.total.memoryBytes) : '—'}</strong></article>
        <article><span>Stack CPU</span><strong>{resources ? `${resources.total.cpuPercent.toFixed(1)}%` : '—'}</strong></article>
        <article><span>System RAM</span><strong>{resources ? `${formatBytes(resources.system.memoryUsedBytes)} / ${formatBytes(resources.system.totalMemoryBytes)}` : '—'}</strong></article>
        <article><span>System CPU</span><strong>{resources ? `${resources.system.cpuPercent.toFixed(1)}%` : '—'}</strong></article>
      </div>
      {resources?.error && <p className="resource-warning" title={resources.error}>Detailed process metrics are temporarily unavailable.</p>}
      <div className="table-wrap resource-table-wrap">
        <table><thead><tr><th>Component</th><th>PID</th><th>Processes</th><th>RAM</th><th>CPU</th><th>Status</th></tr></thead>
          <tbody>{resources?.items.map((item) => <tr key={item.id}>
            <td><strong>{item.label}</strong></td><td><code>{item.pid ?? '—'}</code></td><td>{item.processCount}</td>
            <td>{formatBytes(item.memoryBytes)}</td><td>{item.cpuPercent.toFixed(1)}%</td>
            <td><span className={`badge ${item.status === 'running' ? 'state-ready' : 'state-disabled'}`}>{item.status.toUpperCase()}</span></td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>

    <section className="panel activity-panel">
      <div className="panel-heading">
        <div><p className="eyebrow">CHATGPT ACTIVITY</p><h2>Live Tool Calls</h2></div>
        <div className="badge-group"><span className="badge live-badge">LIVE · 2s</span><button className="ghost" onClick={() => void refresh()}>Refresh</button></div>
      </div>
      <p className="hint">Shows the latest tool calls routed through this manager. File contents and edit payloads are not stored; only safe target/command summaries are shown.</p>
      {toolCalls.length > 0 ? <div className="table-wrap tool-call-table-wrap">
        <table className="tool-call-table">
          <thead><tr><th>Time</th><th>Type</th><th>Tool</th><th>Target / args</th><th>Worker</th><th>Session</th><th>Duration</th><th>Status</th></tr></thead>
          <tbody>{toolCalls.map((call) => {
            const kind = toolKind(call.toolName)
            return <tr key={call.id} title={call.error ?? undefined}>
              <td className="nowrap">{formatTime(call.createdAt)}</td>
              <td><span className={`tool-kind tool-kind-${kind.toLowerCase()}`}>{kind}</span></td>
              <td><code className="tool-name">{call.toolName}</code>{call.failedOver && <span className="failover-note">failover</span>}</td>
              <td className="tool-args" title={call.argsSummary}>{call.argsSummary || '—'}</td>
              <td><code>{call.workerId ?? '—'}</code></td>
              <td><code className="session-code" title={call.sessionId ?? undefined}>{call.sessionId ?? '—'}</code></td>
              <td className="nowrap">{call.durationMs} ms</td>
              <td><span className={`badge tool-status-${call.status.toLowerCase()}`}>{call.status}</span></td>
            </tr>
          })}</tbody>
        </table>
      </div> : <div className="empty-state activity-empty">No tool calls yet. Use Desktop Commander Manager from ChatGPT and activity will appear here automatically.</div>}
    </section>

    <section className="panel">
      <div className="panel-heading"><div><p className="eyebrow">EXECUTION</p><h2>Workers</h2></div><button className="ghost" onClick={() => void refresh()}>Refresh</button></div>
      <div className="worker-grid">
        {workers.map((worker) => <article className="worker-card" key={worker.id}>
          <div className="worker-title"><div><h3>{worker.name}</h3><code>{worker.id}</code></div><span className={`badge state-${worker.status.toLowerCase()}`}>{worker.status}</span></div>
          <dl><div><dt>PID</dt><dd>{worker.pid ?? 'â€”'}</dd></div><div><dt>Load</dt><dd>{worker.activeSessionCount} sessions</dd></div><div><dt>Failures</dt><dd>{worker.failureCount}</dd></div><div><dt>Heartbeat</dt><dd>{formatDate(worker.lastHeartbeatAt)}</dd></div></dl>
          <div className="actions">
            <button disabled={busyAction !== null || !worker.enabled} aria-label={`Restart ${worker.name}`} onClick={() => void act(worker.id, 'restart')}>Restart</button>
            {worker.enabled
              ? <button className="danger" disabled={busyAction !== null} aria-label={`Disable ${worker.name}`} onClick={() => void act(worker.id, 'disable')}>Disable</button>
              : <button disabled={busyAction !== null} aria-label={`Enable ${worker.name}`} onClick={() => void act(worker.id, 'enable')}>Enable</button>}
          </div>
        </article>)}
      </div>
    </section>

    <div className="two-column">
      <section className="panel"><div className="panel-heading"><div><p className="eyebrow">ROUTING</p><h2>Sessions</h2></div></div>
        <div className="table-wrap sessions-table-wrap"><table><thead><tr><th>Session</th><th>Worker</th><th>Last used</th></tr></thead><tbody>{sessions.map((session) => <tr key={session.sessionId}><td><code>{session.sessionId}</code></td><td>{session.workerId}</td><td>{formatDate(session.lastUsedAt)}</td></tr>)}</tbody></table></div>
      </section>
      <section className="panel"><div className="panel-heading"><div><p className="eyebrow">AUDIT</p><h2>Recent events</h2></div></div>
        <div className="event-list">{events.map((event) => <article key={event.id}><div><span className="event-type">{event.type}</span><time>{formatDate(event.createdAt)}</time></div><p>{event.message}</p></article>)}</div>
      </section>
    </div>
  </main>
}
