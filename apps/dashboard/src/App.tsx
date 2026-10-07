import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getConnectionInfo,
  getEvents,
  getHealth,
  getResources,
  getSessions,
  getToolCalls,
  getWorkers,
  workerAction,
} from './api'
import type { ConnectionInfo, EventView, HealthResponse, ResourceProcessUsage, ResourceUsageView, SessionView, ToolCallView, WorkerAction, WorkerView } from './types'
import './styles.css'

type ActivityFilter = 'ALL' | 'READ' | 'WRITE' | 'COMMAND' | 'ERROR'
type DetailTab = 'sessions' | 'events'
type Theme = 'dark' | 'light'
type ConnectionState = 'live' | 'partial' | 'stale' | 'offline' | 'connecting'

const POLL_INTERVAL_MS = 2000
const STALE_AFTER_MS = 6500

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

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatRelative(value: string | null, now: number): string {
  if (!value) return 'No heartbeat'
  const elapsed = Math.max(0, now - new Date(value).getTime())
  const seconds = Math.floor(elapsed / 1000)
  if (seconds < 10) return 'Just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return formatDate(value)
}

function formatBytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(value / 1024 ** 2)} MB`
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function toolKind(name: string): 'READ' | 'WRITE' | 'COMMAND' | 'TOOL' {
  if (['start_process', 'interact_with_process', 'force_terminate', 'kill_process'].includes(name)) return 'COMMAND'
  if (/^(write_|edit_|create_|move_|set_|kill_)/.test(name)) return 'WRITE'
  if (/^(read_|get_|list_|start_search|get_more_search_results|stop_search)/.test(name)) return 'READ'
  return 'TOOL'
}

function readInitialParam(name: string): string {
  return new URLSearchParams(window.location.search).get(name) ?? ''
}

function readInitialFilter(): ActivityFilter {
  const value = readInitialParam('kind').toUpperCase()
  return ['READ', 'WRITE', 'COMMAND', 'ERROR'].includes(value) ? value as ActivityFilter : 'ALL'
}

function readInitialTab(): DetailTab {
  return readInitialParam('view') === 'events' ? 'events' : 'sessions'
}

function failureMessage(result: PromiseRejectedResult): string {
  return result.reason instanceof Error ? result.reason.message : String(result.reason)
}

function ResourceMetric({ label, value, percent, tone = 'primary' }: { label: string; value: string; percent?: number; tone?: 'primary' | 'accent' }) {
  return <article className="resource-metric">
    <div><span>{label}</span><strong>{value}</strong></div>
    {percent === undefined
      ? <div className="metric-rule" aria-hidden="true" />
      : <div className="meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clampPercent(percent))}>
        <span className={`meter-fill meter-${tone}`} style={{ width: `${clampPercent(percent)}%` }} />
      </div>}
  </article>
}

function WorkerCard({ worker, usage, now, busyAction, onAction }: {
  worker: WorkerView
  usage?: ResourceProcessUsage
  now: number
  busyAction: string | null
  onAction(workerId: string, action: WorkerAction): void
}) {
  const isBusy = busyAction !== null
  const actionKey = (action: WorkerAction) => `worker:${worker.id}:${action}`
  return <article className="worker-card">
    <div className="worker-title">
      <div className="worker-identity"><span className={`status-dot state-dot-${worker.status.toLowerCase()}`} aria-hidden="true" /><div><h3>{worker.name}</h3><code>{worker.id}</code></div></div>
      <span className={`badge state-${worker.status.toLowerCase()}`}>{worker.status}</span>
    </div>
    <div className="worker-meta"><span>PID <code>{worker.pid ?? '—'}</code></span><span>{formatRelative(worker.lastHeartbeatAt, now)}</span></div>
    <div className="worker-stats">
      <div><span>Sessions</span><strong>{worker.activeSessionCount}</strong></div>
      <div><span>Failures</span><strong>{worker.failureCount}</strong></div>
      <div><span>RAM</span><strong>{usage ? formatBytes(usage.memoryBytes) : '—'}</strong></div>
      <div><span>CPU</span><strong>{usage ? `${usage.cpuPercent.toFixed(1)}%` : '—'}</strong></div>
    </div>
    <div className="worker-actions">
      <button className="button-secondary" disabled={isBusy || !worker.enabled} aria-label={`Restart ${worker.name}`} onClick={() => onAction(worker.id, 'restart')}>
        {busyAction === actionKey('restart') ? 'Restarting…' : 'Restart'}
      </button>
      {worker.enabled
        ? <button className="button-danger" disabled={isBusy} aria-label={`Disable ${worker.name}`} onClick={() => onAction(worker.id, 'disable')}>{busyAction === actionKey('disable') ? 'Disabling…' : 'Disable'}</button>
        : <button className="button-primary" disabled={isBusy} aria-label={`Enable ${worker.name}`} onClick={() => onAction(worker.id, 'enable')}>{busyAction === actionKey('enable') ? 'Enabling…' : 'Enable'}</button>}
    </div>
  </article>
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
  const [failedSources, setFailedSources] = useState<string[]>([])
  const [lastSuccessfulAt, setLastSuccessfulAt] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())
  const [refreshing, setRefreshing] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>(readInitialFilter)
  const [workerFilter, setWorkerFilter] = useState(() => readInitialParam('worker'))
  const [searchQuery, setSearchQuery] = useState(() => readInitialParam('q'))
  const [detailTab, setDetailTab] = useState<DetailTab>(readInitialTab)
  const [selectedCall, setSelectedCall] = useState<ToolCallView | null>(null)
  const [copiedValue, setCopiedValue] = useState<string | null>(null)
  const [theme, setTheme] = useState<Theme>(() => window.localStorage.getItem('dashboard-theme') === 'light' ? 'light' : 'dark')
  const refreshInFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    setRefreshing(true)
    const [healthResult, connectionResult, workersResult, resourcesResult, sessionsResult, eventsResult, callsResult] = await Promise.allSettled([
      getHealth(), getConnectionInfo(), getWorkers(), getResources(), getSessions(), getEvents(), getToolCalls(),
    ])

    const failures: string[] = []
    let successfulSources = 0
    if (healthResult.status === 'fulfilled') { setHealth(healthResult.value); successfulSources += 1 } else failures.push(`health: ${failureMessage(healthResult)}`)
    if (connectionResult.status === 'fulfilled') { setConnectionInfo(connectionResult.value); successfulSources += 1 } else failures.push(`connection: ${failureMessage(connectionResult)}`)
    if (workersResult.status === 'fulfilled') { setWorkers(workersResult.value); successfulSources += 1 } else failures.push(`workers: ${failureMessage(workersResult)}`)
    if (resourcesResult.status === 'fulfilled') { setResources(resourcesResult.value); successfulSources += 1 } else failures.push(`resources: ${failureMessage(resourcesResult)}`)
    if (sessionsResult.status === 'fulfilled') { setSessions(sessionsResult.value); successfulSources += 1 } else failures.push(`sessions: ${failureMessage(sessionsResult)}`)
    if (eventsResult.status === 'fulfilled') { setEvents(eventsResult.value); successfulSources += 1 } else failures.push(`events: ${failureMessage(eventsResult)}`)
    if (callsResult.status === 'fulfilled') { setToolCalls(callsResult.value); successfulSources += 1 } else failures.push(`tool calls: ${failureMessage(callsResult)}`)

    if (successfulSources > 0) setLastSuccessfulAt(Date.now())
    setFailedSources(failures.map((failure) => failure.split(':', 1)[0]))
    setError(failures.length ? failures.join(' · ') : null)
    setRefreshing(false)
    refreshInFlight.current = false
  }, [])

  useEffect(() => {
    void refresh()
    const pollTimer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS)
    const clockTimer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => { window.clearInterval(pollTimer); window.clearInterval(clockTimer) }
  }, [refresh])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem('dashboard-theme', theme)
  }, [theme])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    activityFilter === 'ALL' ? params.delete('kind') : params.set('kind', activityFilter.toLowerCase())
    workerFilter ? params.set('worker', workerFilter) : params.delete('worker')
    searchQuery ? params.set('q', searchQuery) : params.delete('q')
    detailTab === 'sessions' ? params.delete('view') : params.set('view', detailTab)
    const query = params.toString()
    window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`)
  }, [activityFilter, workerFilter, searchQuery, detailTab])

  useEffect(() => {
    if (!selectedCall) return
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelectedCall(null) }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [selectedCall])

  const act = async (workerId: string, action: WorkerAction) => {
    const key = `worker:${workerId}:${action}`
    setBusyAction(key)
    try { await workerAction(workerId, action); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusyAction(null) }
  }

  const copyText = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedValue(value)
      window.setTimeout(() => setCopiedValue((current) => current === value ? null : current), 1600)
    } catch {
      setError('Clipboard access is unavailable in this browser.')
    }
  }

  const connectionState: ConnectionState = useMemo(() => {
    if (lastSuccessfulAt === null) return error ? 'offline' : 'connecting'
    if (now - lastSuccessfulAt > STALE_AFTER_MS) return 'stale'
    if (failedSources.length > 0 || resources?.available === false) return 'partial'
    return 'live'
  }, [error, failedSources.length, lastSuccessfulAt, now, resources?.available])

  const filteredCalls = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return toolCalls.filter((call) => {
      if (workerFilter && call.workerId !== workerFilter) return false
      if (activityFilter === 'ERROR' && call.status !== 'ERROR') return false
      if (!['ALL', 'ERROR'].includes(activityFilter) && toolKind(call.toolName) !== activityFilter) return false
      if (!query) return true
      return [call.toolName, call.argsSummary, call.workerId, call.sessionId, call.error].some((value) => value?.toLowerCase().includes(query))
    })
  }, [activityFilter, searchQuery, toolCalls, workerFilter])

  const readyWorkers = workers.filter((worker) => worker.status === 'READY' || worker.status === 'BUSY').length
  const recentErrors = toolCalls.filter((call) => call.status === 'ERROR').length
  const endpoint = connectionInfo?.mcpUrl ?? 'http://127.0.0.1:8787/mcp'
  const systemRamPercent = resources && resources.system.totalMemoryBytes > 0 ? (resources.system.memoryUsedBytes / resources.system.totalMemoryBytes) * 100 : 0
  const workerUsage = new Map(resources?.items.map((item) => [item.id, item]) ?? [])
  const lastUpdatedLabel = lastSuccessfulAt === null ? 'Waiting for first snapshot' : formatRelative(new Date(lastSuccessfulAt).toISOString(), now)
  const connectionLabel = connectionState === 'live' ? 'LIVE' : connectionState === 'partial' ? 'PARTIAL' : connectionState === 'stale' ? 'STALE' : connectionState === 'offline' ? 'OFFLINE' : 'CONNECTING'

  return <main className="app-shell">
    <header className="command-bar">
      <div className="brand-lockup"><img className="brand-mark" src="/desktop-commander-manager.png?v=20261007-2" alt="" aria-hidden="true" /><div><p className="eyebrow">LOCAL CONTROL PLANE</p><h1>Desktop Commander Manager</h1></div></div>
      <div className="command-actions">
        <div className={`connection-status connection-${connectionState}`} role="status"><span className="status-dot" aria-hidden="true" /><div><strong>{connectionLabel}</strong><span>{lastUpdatedLabel}</span></div></div>
        <button className="icon-button" aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? 'Light' : 'Dark'}</button>
        <button
          className="icon-button refresh-button"
          aria-busy={refreshing}
          aria-label={refreshing ? 'Refreshing dashboard' : 'Refresh dashboard'}
          disabled={refreshing}
          onClick={() => void refresh()}
          title={refreshing ? 'Refreshing dashboard' : 'Refresh dashboard'}
        >
          <svg className={`refresh-icon${refreshing ? ' is-spinning' : ''}`} viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.34 5.66M20 4v7h-7" />
          </svg>
        </button>
      </div>
    </header>

    <div className="endpoint-bar">
      <div><span className="mode-label">Direct local</span><span className="route-copy">ChatGPT / Secure MCP Tunnel <b>→</b> <code>{endpoint}</code> <b>→</b> Local workers</span></div>
      <button className="copy-button" onClick={() => void copyText(endpoint)}>{copiedValue === endpoint ? 'Copied' : 'Copy endpoint'}</button>
    </div>

    {error && <div role="alert" className={`alert ${connectionState === 'offline' ? 'alert-critical' : ''}`}><div><strong>{connectionState === 'offline' ? 'Dashboard offline' : 'Some data is temporarily unavailable'}</strong><span>{error}</span></div><button onClick={() => void refresh()}>Retry</button></div>}

    <section className="status-strip" aria-label="Manager summary">
      <article><span>Workers ready</span><strong>{readyWorkers}<small> / {workers.length}</small></strong></article>
      <article><span>Active sessions</span><strong>{sessions.length}</strong></article>
      <article className={recentErrors > 0 ? 'metric-alert' : ''}><span>Errors in latest calls</span><strong>{recentErrors}</strong></article>
      <article><span>Stack usage</span><strong>{resources ? formatBytes(resources.total.memoryBytes) : '—'}<small>{resources ? ` · ${resources.total.cpuPercent.toFixed(1)}% CPU` : ''}</small></strong></article>
      <article><span>Manager uptime</span><strong>{health ? formatUptime(health.uptimeMs) : '—'}</strong></article>
    </section>

    <div className="primary-grid">
      <section className="workspace-panel activity-panel">
        <div className="section-heading">
          <div><p className="eyebrow">CHATGPT ACTIVITY</p><h2>Live activity</h2><p>Latest tool calls routed through this manager. Payload contents are never stored.</p></div>
          <span className="result-count">{filteredCalls.length} of {toolCalls.length}</span>
        </div>
        <div className="activity-toolbar">
          <div className="filter-tabs" role="group" aria-label="Filter tool calls by type">
            {(['ALL', 'READ', 'WRITE', 'COMMAND', 'ERROR'] as ActivityFilter[]).map((filter) => <button key={filter} className={activityFilter === filter ? 'active' : ''} aria-pressed={activityFilter === filter} onClick={() => setActivityFilter(filter)}>{filter === 'ALL' ? 'All' : filter[0] + filter.slice(1).toLowerCase()}</button>)}
          </div>
          <div className="activity-inputs">
            <label className="search-field"><span className="sr-only">Search tool calls</span><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search tool, path, session…" /></label>
            <label className="select-field"><span className="sr-only">Filter by worker</span><select value={workerFilter} onChange={(event) => setWorkerFilter(event.target.value)}><option value="">All workers</option>{workers.map((worker) => <option key={worker.id} value={worker.id}>{worker.name}</option>)}</select></label>
          </div>
        </div>

        {filteredCalls.length > 0 ? <div className="activity-list" role="list">
          <div className="activity-header" aria-hidden="true"><span>Time</span><span>Type</span><span>Tool / target</span><span>Worker</span><span>Duration</span><span>Status</span></div>
          {filteredCalls.map((call) => {
            const kind = toolKind(call.toolName)
            return <article className={`activity-row ${call.status === 'ERROR' ? 'activity-row-error' : ''}`} key={call.id} role="listitem">
              <time>{formatTime(call.createdAt)}</time>
              <span><span className={`tool-kind tool-kind-${kind.toLowerCase()}`}>{kind}</span></span>
              <div className="activity-target"><button className="tool-link" onClick={() => setSelectedCall(call)} aria-label={`View details for ${call.toolName}`}>{call.toolName}</button><span title={call.argsSummary}>{call.argsSummary || 'No target summary'}</span>{call.failedOver && <em>Failover</em>}</div>
              <code>{call.workerId ?? '—'}</code>
              <span className="duration">{call.durationMs} ms</span>
              <span><span className={`badge tool-status-${call.status.toLowerCase()}`}>{call.status}</span></span>
            </article>
          })}
        </div> : <div className="empty-state"><strong>{toolCalls.length ? 'No calls match these filters' : 'No tool calls yet'}</strong><span>{toolCalls.length ? 'Clear a filter or try another search.' : 'Activity will appear automatically after ChatGPT uses a Desktop Commander tool.'}</span>{toolCalls.length > 0 && <button onClick={() => { setActivityFilter('ALL'); setWorkerFilter(''); setSearchQuery('') }}>Clear filters</button>}</div>}
      </section>

      <aside className="worker-rail workspace-panel" aria-label="Workers">
        <div className="section-heading compact"><div><p className="eyebrow">EXECUTION</p><h2>Workers</h2></div><span className="result-count">{readyWorkers}/{workers.length} ready</span></div>
        <div className="worker-list">{workers.map((worker) => <WorkerCard key={worker.id} worker={worker} usage={workerUsage.get(worker.id)} now={now} busyAction={busyAction} onAction={(id, action) => void act(id, action)} />)}</div>
      </aside>
    </div>

    <div className="secondary-grid">
      <section className="workspace-panel resource-panel">
        <div className="section-heading compact"><div><p className="eyebrow">SYSTEM</p><h2>Resource usage</h2></div><span className={`badge ${resources?.available ? 'state-ready' : 'state-degraded'}`}>{resources?.available ? 'LIVE SAMPLE' : 'LIMITED'}</span></div>
        <div className="resource-overview">
          <ResourceMetric label="System RAM" value={resources ? `${formatBytes(resources.system.memoryUsedBytes)} / ${formatBytes(resources.system.totalMemoryBytes)}` : '—'} percent={systemRamPercent} />
          <ResourceMetric label="System CPU" value={resources ? `${resources.system.cpuPercent.toFixed(1)}%` : '—'} percent={resources?.system.cpuPercent ?? 0} tone="accent" />
          <ResourceMetric label="Stack RAM" value={resources ? formatBytes(resources.total.memoryBytes) : '—'} />
          <ResourceMetric label="Stack CPU" value={resources ? `${resources.total.cpuPercent.toFixed(1)}%` : '—'} percent={resources?.total.cpuPercent ?? 0} tone="accent" />
        </div>
        {resources?.error && <p className="resource-warning" title={resources.error}>Detailed process metrics are temporarily unavailable; the last manager snapshot remains visible.</p>}
        <div className="process-list">
          {resources?.items.map((item) => <div className="process-row" key={item.id}><div><span className={`status-dot ${item.status === 'running' ? 'dot-ready' : 'dot-disabled'}`} aria-hidden="true" /><strong>{item.label}</strong><code>PID {item.pid ?? '—'}</code></div><span>{item.processCount} proc</span><span>{formatBytes(item.memoryBytes)}</span><span>{item.cpuPercent.toFixed(1)}%</span></div>)}
        </div>
      </section>

      <section className="workspace-panel detail-panel">
        <div className="detail-tabs" role="tablist" aria-label="Routing and audit details">
          <button role="tab" aria-selected={detailTab === 'sessions'} className={detailTab === 'sessions' ? 'active' : ''} onClick={() => setDetailTab('sessions')}>Routing sessions <span>{sessions.length}</span></button>
          <button role="tab" aria-selected={detailTab === 'events'} className={detailTab === 'events' ? 'active' : ''} onClick={() => setDetailTab('events')}>Audit events <span>{events.length}</span></button>
        </div>
        {detailTab === 'sessions' ? <div className="session-list" role="tabpanel">
          {sessions.length ? sessions.map((session) => <article key={session.sessionId}><div><code title={session.sessionId}>{session.sessionId}</code><button aria-label={`Copy session ${session.sessionId}`} onClick={() => void copyText(session.sessionId)}>{copiedValue === session.sessionId ? 'Copied' : 'Copy'}</button></div><span className="route-arrow">→</span><strong>{session.workerId}</strong><time>{formatRelative(session.lastUsedAt, now)}</time></article>) : <div className="empty-state compact-empty">No active routing sessions.</div>}
        </div> : <div className="event-list" role="tabpanel">
          {events.length ? events.map((event) => <article key={event.id}><span className="event-marker" aria-hidden="true" /><div><div><strong>{event.type}</strong><time>{formatRelative(event.createdAt, now)}</time></div><p>{event.message}</p></div></article>) : <div className="empty-state compact-empty">No audit events yet.</div>}
        </div>}
      </section>
    </div>

    {selectedCall && <div className="drawer-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setSelectedCall(null) }}>
      <aside className="detail-drawer" role="dialog" aria-modal="true" aria-labelledby="tool-detail-title">
        <div className="drawer-header"><div><p className="eyebrow">TOOL CALL #{selectedCall.id}</p><h2 id="tool-detail-title">{selectedCall.toolName}</h2></div><button className="drawer-close" aria-label="Close tool call details" onClick={() => setSelectedCall(null)}>Close</button></div>
        <div className="drawer-status"><span className={`tool-kind tool-kind-${toolKind(selectedCall.toolName).toLowerCase()}`}>{toolKind(selectedCall.toolName)}</span><span className={`badge tool-status-${selectedCall.status.toLowerCase()}`}>{selectedCall.status}</span>{selectedCall.failedOver && <span className="badge state-starting">FAILOVER</span>}</div>
        <dl className="detail-list">
          <div><dt>Time</dt><dd>{formatDate(selectedCall.createdAt)}</dd></div>
          <div><dt>Duration</dt><dd>{selectedCall.durationMs} ms</dd></div>
          <div><dt>Worker</dt><dd><code>{selectedCall.workerId ?? '—'}</code></dd></div>
          <div><dt>Session</dt><dd><code>{selectedCall.sessionId ?? '—'}</code>{selectedCall.sessionId && <button onClick={() => void copyText(selectedCall.sessionId!)}>{copiedValue === selectedCall.sessionId ? 'Copied' : 'Copy'}</button>}</dd></div>
          <div className="detail-wide"><dt>Target / argument summary</dt><dd><code>{selectedCall.argsSummary || 'No summary recorded'}</code></dd></div>
          {selectedCall.error && <div className="detail-wide detail-error"><dt>Error</dt><dd>{selectedCall.error}</dd></div>}
        </dl>
        <p className="drawer-note">Only redacted target and command summaries are stored. File contents and edit payloads are not retained.</p>
      </aside>
    </div>}
  </main>
}
