export type WorkerStatus = 'STOPPED' | 'STARTING' | 'READY' | 'BUSY' | 'DEGRADED' | 'OFFLINE' | 'DISABLED'

export interface HealthResponse {
  status: string
  startedAt: string
  uptimeMs: number
}

export interface WorkerView {
  id: string
  name: string
  enabled: boolean
  status: WorkerStatus
  pid: number | null
  failureCount: number
  lastHeartbeatAt: string | null
  createdAt: string
  updatedAt: string
  activeSessionCount: number
}

export interface SessionView {
  sessionId: string
  workerId: string
  createdAt: string
  lastUsedAt: string
}

export interface EventView {
  id: number
  sessionId: string | null
  workerId: string | null
  type: string
  message: string
  metadataJson: string | null
  createdAt: string
}

export type WorkerAction = 'restart' | 'enable' | 'disable'
