import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { createDefaultManagerConfig } from './cli'

describe('CLI defaults', () => {
  it('keeps database, worker runtime, and dashboard paths inside the repository', () => {
    const root = resolve('D:/example/dc-manager')
    expect(createDefaultManagerConfig(root)).toEqual({
      databasePath: join(root, 'data', 'manager.db'),
      runtimeRoot: join(root, 'data', 'workers'),
      dashboardDir: join(root, 'apps', 'dashboard', 'dist'),
      mcpPort: 8787,
      managementPort: 8788,
    })
  })
})
