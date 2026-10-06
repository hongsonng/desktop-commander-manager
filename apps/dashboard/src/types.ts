export type WorkerStatus = 'STOPPED' | 'STARTING' | 'READY' | 'BUSY' | 'DEGRADED' | 'OFFLINE' | 'DISABLED'
export interface HealthResponse {
  status: string
  startedAt: string
  uptimeMs: number
}

export interface ConnectionInfo {
  mode: 'direct-local'
  mcpUrl: string
  hostedRemoteAccountRequired: false
  workerStrategy: 'sticky-failover'
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

export interface ToolCallView {
  id: number
  sessionId: string | null
  workerId: string | null
  toolName: string
  argsSummary: string
  status: 'OK' | 'ERROR'
  durationMs: number
  failedOver: boolean
  error: string | null
  createdAt: string
}

export type WorkerAction = 'restart' | 'enable' | 'disable'
