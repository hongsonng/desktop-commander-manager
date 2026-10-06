import type { ConnectionInfo, EventView, HealthResponse, SessionView, ToolCallView, WorkerAction, WorkerView } from './types'

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
export function getSessions(): Promise<SessionView[]> { return requestJson('/api/sessions') }
export function getEvents(): Promise<EventView[]> { return requestJson('/api/events') }
export function getToolCalls(): Promise<ToolCallView[]> { return requestJson('/api/tool-calls') }

export async function workerAction(workerId: string, action: WorkerAction): Promise<void> {
  await requestJson(`/api/workers/${encodeURIComponent(workerId)}/${action}`, { method: 'POST' })
}
