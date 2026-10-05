export const WORKER_STATUSES = [
  'STOPPED',
  'STARTING',
  'READY',
  'BUSY',
  'DEGRADED',
  'OFFLINE',
  'DISABLED',
] as const

export type WorkerStatus = (typeof WORKER_STATUSES)[number]

export const REMOTE_ACCOUNT_STATUSES = [
  'STOPPED',
  'STARTING',
  'RUNNING',
  'PAIRING',
  'ERROR',
  'DISABLED',
] as const

export type RemoteAccountStatus = (typeof REMOTE_ACCOUNT_STATUSES)[number]

export interface WorkerRecord {
  id: string
  name: string
  enabled: boolean
  status: WorkerStatus
  pid: number | null
  failureCount: number
  lastHeartbeatAt: string | null
  createdAt: string
  updatedAt: string
}

export interface RemoteAccountRecord {
  id: string
  name: string
  enabled: boolean
  status: RemoteAccountStatus
  pid: number | null
  profileDir: string
  lastStartedAt: string | null
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface SessionBinding {
  sessionId: string
  workerId: string
  createdAt: string
  lastUsedAt: string
}

export interface EventRecord {
  id: number
  sessionId: string | null
  workerId: string | null
  type: string
  message: string
  metadataJson: string | null
  createdAt: string
}

export interface WorkerDescriptor extends WorkerRecord {
  activeSessionCount: number
}

export interface RouteContext {
  sessionId?: string | null
  connectionId: string
}
