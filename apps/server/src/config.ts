import type { CapabilityOwner } from './native-sidecar.js'

export type { CapabilityOwner } from './native-sidecar.js'

export interface ManagerConfig {
  databasePath: string
  runtimeRoot: string
  mcpPort?: number
  managementPort?: number
  dashboardDir?: string
  platformOwner?: CapabilityOwner
  nativeSidecarPath?: string
}

export const DEFAULT_MCP_PORT = 8787
export const DEFAULT_MANAGEMENT_PORT = 8788
