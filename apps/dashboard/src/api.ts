import type { ConnectionInfo, EventView, HealthResponse, RemoteAccountAction, RemoteAccountView, SessionView, ToolCallView, WorkerAction, WorkerView } from './types'

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `${response.status} ${response.statusText}`)
  }
  return await response.json() as T
}

export function getHealth(): Promise<HealthResponse> { return requestJson('/api/health') }
export function getConnectionInfo(): Promise<ConnectionInfo> { return requestJson('/api/connection') }
export function getWorkers(): Promise<WorkerView[]> { return requestJson('/api/workers') }
export function getRemoteAccounts(): Promise<RemoteAccountView[]> { return requestJson('/api/remote-accounts') }
export function getSessions(): Promise<SessionView[]> { return requestJson('/api/sessions') }
export function getEvents(): Promise<EventView[]> { return requestJson('/api/events') }
export function getToolCalls(): Promise<ToolCallView[]> { return requestJson('/api/tool-calls') }

export async function workerAction(workerId: string, action: WorkerAction): Promise<void> {
  await requestJson(`/api/workers/${encodeURIComponent(workerId)}/${action}`, { method: 'POST' })
}

export async function addRemoteAccount(account: { id: string; name: string }): Promise<void> {
  await requestJson('/api/remote-accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(account),
  })
}

export async function remoteAccountAction(accountId: string, action: RemoteAccountAction): Promise<void> {
  await requestJson(`/api/remote-accounts/${encodeURIComponent(accountId)}/${action}`, { method: 'POST' })
}

export async function rotateRemoteAccount(): Promise<void> {
  await requestJson('/api/remote-accounts/rotate', { method: 'POST' })
}
