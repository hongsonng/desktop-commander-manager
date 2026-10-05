import { type FormEvent, useCallback, useEffect, useState } from 'react'
import {
  addRemoteAccount,
  getEvents,
  getHealth,
  getRemoteAccounts,
  getSessions,
  getWorkers,
  remoteAccountAction,
  rotateRemoteAccount,
  workerAction,
} from './api'
import type { EventView, HealthResponse, RemoteAccountAction, RemoteAccountView, SessionView, WorkerAction, WorkerView } from './types'
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

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [workers, setWorkers] = useState<WorkerView[]>([])
  const [remoteAccounts, setRemoteAccounts] = useState<RemoteAccountView[]>([])
  const [sessions, setSessions] = useState<SessionView[]>([])
  const [events, setEvents] = useState<EventView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [accountId, setAccountId] = useState('')
  const [accountName, setAccountName] = useState('')

  const refresh = useCallback(async () => {
    try {
      const [nextHealth, nextWorkers, nextRemoteAccounts, nextSessions, nextEvents] = await Promise.all([
        getHealth(), getWorkers(), getRemoteAccounts(), getSessions(), getEvents(),
      ])
      setHealth(nextHealth)
      setWorkers(nextWorkers)
      setRemoteAccounts(nextRemoteAccounts)
      setSessions(nextSessions)
      setEvents(nextEvents)
      setError(null)
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
    const key = `worker:${workerId}:${action}`
    setBusyAction(key)
    try { await workerAction(workerId, action); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusyAction(null) }
  }

  const remoteAct = async (accountIdValue: string, action: RemoteAccountAction) => {
    const key = `account:${accountIdValue}:${action}`
    setBusyAction(key)
    try { await remoteAccountAction(accountIdValue, action); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusyAction(null) }
  }

  const rotateAccount = async () => {
    setBusyAction('account:rotate')
    try { await rotateRemoteAccount(); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusyAction(null) }
  }

  const submitAccount = async (event: FormEvent) => {
    event.preventDefault()
    const id = accountId.trim()
    const name = accountName.trim()
    if (!id || !name) return
    setBusyAction('account:add')
    try {
      await addRemoteAccount({ id, name })
      setAccountId('')
      setAccountName('')
      await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
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
      <article><span>Account profiles</span><strong>{remoteAccounts.length}</strong></article>
      <article><span>Active sessions</span><strong>{sessions.length}</strong></article>
      <article><span>Uptime</span><strong>{health ? formatUptime(health.uptimeMs) : 'â€”'}</strong></article>
    </section>

    <section className="panel">
      <div className="panel-heading">
        <div><p className="eyebrow">REMOTE DEVICE PROFILES</p><h2>Remote accounts</h2></div>
        <button className="primary" aria-label="Rotate next account" disabled={busyAction !== null || remoteAccounts.filter((item) => item.enabled).length === 0} onClick={() => void rotateAccount()}>Rotate next</button>
      </div>
      <form className="remote-form" onSubmit={(event) => void submitAccount(event)}>
        <label>Account id<input aria-label="Account id" value={accountId} onChange={(event) => setAccountId(event.target.value)} placeholder="account-a" /></label>
        <label>Account name<input aria-label="Account name" value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder="Main account" /></label>
        <button type="submit" disabled={busyAction !== null || !accountId.trim() || !accountName.trim()}>Add account</button>
      </form>
      <p className="hint">Each account uses its own HOME profile. Desktop Commander owns the login credential; this manager only tracks profile state and process lifecycle.</p>
      <div className="worker-grid account-grid">
        {remoteAccounts.map((account) => <article className="worker-card" key={account.id}>
          <div className="worker-title">
            <div><h3>{account.name}</h3><code>{account.id}</code></div>
            <div className="badge-group"><span className={`badge ${account.paired ? 'paired' : 'unpaired'}`}>{account.paired ? 'Paired' : 'Not paired'}</span><span className={`badge state-${account.status.toLowerCase()}`}>{account.status}</span></div>
          </div>
          <dl>
            <div><dt>PID</dt><dd>{account.pid ?? 'â€”'}</dd></div>
            <div><dt>Last used</dt><dd>{formatDate(account.lastUsedAt)}</dd></div>
            <div className="wide"><dt>Profile</dt><dd title={account.profileDir}>{account.profileDir}</dd></div>
          </dl>
          <div className="actions">
            {account.status === 'RUNNING' || account.status === 'STARTING'
              ? <button disabled={busyAction !== null} aria-label={`Stop ${account.name}`} onClick={() => void remoteAct(account.id, 'stop')}>Stop</button>
              : <button disabled={busyAction !== null || !account.enabled} aria-label={`Activate ${account.name}`} onClick={() => void remoteAct(account.id, 'activate')}>Activate</button>}
            {account.enabled
              ? <button className="danger" disabled={busyAction !== null} aria-label={`Disable ${account.name}`} onClick={() => void remoteAct(account.id, 'disable')}>Disable</button>
              : <button disabled={busyAction !== null} aria-label={`Enable ${account.name}`} onClick={() => void remoteAct(account.id, 'enable')}>Enable</button>}
          </div>
        </article>)}
        {remoteAccounts.length === 0 && <div className="empty-state">Add an account profile to start pairing and rotation.</div>}
      </div>
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
        <div className="table-wrap"><table><thead><tr><th>Session</th><th>Worker</th><th>Last used</th></tr></thead><tbody>{sessions.map((session) => <tr key={session.sessionId}><td><code>{session.sessionId}</code></td><td>{session.workerId}</td><td>{formatDate(session.lastUsedAt)}</td></tr>)}</tbody></table></div>
      </section>
      <section className="panel"><div className="panel-heading"><div><p className="eyebrow">AUDIT</p><h2>Recent events</h2></div></div>
        <div className="event-list">{events.map((event) => <article key={event.id}><div><span className="event-type">{event.type}</span><time>{formatDate(event.createdAt)}</time></div><p>{event.message}</p></article>)}</div>
      </section>
    </div>
  </main>
}
