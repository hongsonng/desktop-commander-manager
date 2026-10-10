import type { CapabilityOwner } from './native-sidecar.js'

export type { CapabilityOwner } from './native-sidecar.js'
export type StateOwner = 'node' | 'rust'
export type ManagementApiOwner = 'node' | 'rust'

export interface ManagerConfig {
  databasePath: string
  runtimeRoot: string
  mcpPort?: number
  managementPort?: number
  dashboardDir?: string
  platformOwner?: CapabilityOwner
  workerOwner?: CapabilityOwner
  stateOwner?: StateOwner
  managementApiOwner?: ManagementApiOwner
  nativeSidecarPath?: string
}

export const DEFAULT_MCP_PORT = 8787
export const DEFAULT_MANAGEMENT_PORT = 8788
