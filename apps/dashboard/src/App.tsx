import { useCallback, useEffect, useState } from 'react'
import { getEvents, getHealth, getSessions, getWorkers, workerAction } from './api'
import type { EventView, HealthResponse, SessionView, WorkerAction, WorkerView } from './types'
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
  return value ? new Date(value).toLocaleString() : '—'
}

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [workers, setWorkers] = useState<WorkerView[]>([])
  const [sessions, setSessions] = useState<SessionView[]>([])
  const [events, setEvents] = useState<EventView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [nextHealth, nextWorkers, nextSessions, nextEvents] = await Promise.all([
        getHealth(), getWorkers(), getSessions(), getEvents(),
      ])
      setHealth(nextHealth); setWorkers(nextWorkers); setSessions(nextSessions); setEvents(nextEvents); setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const act = async (workerId: string, action: WorkerAction) => {
    const key = `${workerId}:${action}`
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

    <section className="stats" aria-label="Manager summary">
      <article><span>Workers</span><strong>{workers.length}</strong></article>
      <article><span>Active sessions</span><strong>{sessions.length}</strong></article>
      <article><span>Uptime</span><strong>{health ? formatUptime(health.uptimeMs) : '—'}</strong></article>
    </section>

    <section className="panel">
      <div className="panel-heading"><div><p className="eyebrow">EXECUTION</p><h2>Workers</h2></div><button className="ghost" onClick={() => void refresh()}>Refresh</button></div>
      <div className="worker-grid">
        {workers.map((worker) => <article className="worker-card" key={worker.id}>
          <div className="worker-title"><div><h3>{worker.name}</h3><code>{worker.id}</code></div><span className={`badge state-${worker.status.toLowerCase()}`}>{worker.status}</span></div>
          <dl><div><dt>PID</dt><dd>{worker.pid ?? '—'}</dd></div><div><dt>Load</dt><dd>{worker.activeSessionCount} sessions</dd></div><div><dt>Failures</dt><dd>{worker.failureCount}</dd></div><div><dt>Heartbeat</dt><dd>{formatDate(worker.lastHeartbeatAt)}</dd></div></dl>
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
        <div className="table-wrap"><table><thead><tr><th>Session</th><th>Worker</th><th>Last used</th></tr></thead><tbody>{sessions.map((session) => <tr key={session.sessionId}><td><code>{session.sessionId}</code></td><td>{session.workerId}</td><td>{formatDate(session.lastUsedAt)}</td></tr>)}</tbody></table></div>
      </section>
      <section className="panel"><div className="panel-heading"><div><p className="eyebrow">AUDIT</p><h2>Recent events</h2></div></div>
        <div className="event-list">{events.map((event) => <article key={event.id}><div><span className="event-type">{event.type}</span><time>{formatDate(event.createdAt)}</time></div><p>{event.message}</p></article>)}</div>
      </section>
    </div>
  </main>
}
