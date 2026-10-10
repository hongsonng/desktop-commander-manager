import { describe, expect, it } from 'vitest'
import vitestConfig from '../../vitest.config.js'

describe('Vitest process concurrency', () => {
  it('runs test files serially on Windows CI runners', () => {
    const config = typeof vitestConfig === 'function'
      ? vitestConfig({ command: 'serve', mode: 'test', isSsrBuild: false, isPreview: false })
      : vitestConfig

    const expectedWorkers = process.platform === 'win32' && process.env.CI
      ? 1
      : 4

    expect(config.test?.maxWorkers).toBe(expectedWorkers)
  })
})
