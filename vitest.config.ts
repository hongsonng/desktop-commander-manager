import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'apps/**/*.test.tsx', 'tests/**/*.test.ts'],
    // Contract and recovery suites launch real Node/Rust worker trees. Capping
    // file concurrency prevents handshake timeouts caused by process saturation.
    maxWorkers: 4,
  },
})
