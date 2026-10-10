import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveDesktopCommanderPackage,
  resolveDesktopCommanderSpawnSpec,
} from './desktop-commander-package.js'

describe('desktop-commander package resolution', () => {
  it('resolves the installed Desktop Commander package and bin executable', () => {
    const pkg = resolveDesktopCommanderPackage()
    expect(pkg.version).toBe('0.2.52')
    expect(existsSync(pkg.packageJsonPath)).toBe(true)
    expect(existsSync(pkg.binPath)).toBe(true)
    expect(pkg.binPath).toMatch(/dist[/\\]index\.js$/)
  })

  it('builds a direct node spawn specification with --no-onboarding and no @latest', () => {
    const spec = resolveDesktopCommanderSpawnSpec()
    expect(spec.command).toBe(process.execPath)
    expect(spec.args).toHaveLength(2)
    expect(spec.args[0]).toMatch(/dist[/\\]index\.js$/)
    expect(spec.args[1]).toBe('--no-onboarding')
    expect(spec.args.some((arg) => arg.includes('@latest'))).toBe(false)
  })

  it('throws an actionable error when package is not found in an empty directory', () => {
    const emptyDirectory = mkdtempSync(join(tmpdir(), 'dcm-empty-package-'))
    try {
      expect(() => resolveDesktopCommanderPackage(emptyDirectory)).toThrow(
        /Could not resolve @wonderwhy-er\/desktop-commander package/i,
      )
    } finally {
      rmSync(emptyDirectory, { recursive: true, force: true })
    }
  })
})
