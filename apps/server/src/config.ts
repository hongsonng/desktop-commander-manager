export interface ManagerConfig {
  databasePath: string
  runtimeRoot: string
  mcpPort?: number
  managementPort?: number
}

export const DEFAULT_MCP_PORT = 8787
export const DEFAULT_MANAGEMENT_PORT = 8788
