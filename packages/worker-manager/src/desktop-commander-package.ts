import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

export interface DesktopCommanderSpawnSpec {
  command: string
  args: string[]
}

export function resolveDesktopCommanderPackage(baseDir: string = process.cwd()): {
  packageJsonPath: string
  binPath: string
  version: string
} {
  let packageJsonPath: string | null = null

  // 1. Try require.resolve
  try {
    const req = createRequire(resolve(baseDir, 'package.json'))
    packageJsonPath = req.resolve('@wonderwhy-er/desktop-commander/package.json')
  } catch {
    // 2. Fallback: search upward from baseDir
    let current = resolve(baseDir)
    while (true) {
      const candidate = join(current, 'node_modules', '@wonderwhy-er', 'desktop-commander', 'package.json')
      if (existsSync(candidate)) {
        packageJsonPath = candidate
        break
      }
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }

  if (!packageJsonPath || !existsSync(packageJsonPath)) {
    throw new Error(
      'Could not resolve @wonderwhy-er/desktop-commander package. Please ensure it is installed in node_modules.',
    )
  }

  const pkgJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const pkgDir = dirname(packageJsonPath)

  let binRel: string | undefined
  if (typeof pkgJson.bin === 'string') {
    binRel = pkgJson.bin
  } else if (pkgJson.bin && typeof pkgJson.bin === 'object') {
    binRel = pkgJson.bin['desktop-commander'] ?? Object.values(pkgJson.bin)[0]
  }

  if (!binRel) {
    throw new Error(`Package @wonderwhy-er/desktop-commander does not define a bin executable`)
  }

  const binPath = resolve(pkgDir, binRel)
  if (!existsSync(binPath)) {
    throw new Error(`Desktop Commander bin executable not found at: ${binPath}`)
  }

  return {
    packageJsonPath,
    binPath,
    version: pkgJson.version ?? 'unknown',
  }
}

export function resolveDesktopCommanderSpawnSpec(
  baseDir: string = process.cwd(),
  _env?: NodeJS.ProcessEnv,
): DesktopCommanderSpawnSpec {
  const pkg = resolveDesktopCommanderPackage(baseDir)
  return {
    command: process.execPath,
    args: [pkg.binPath, '--no-onboarding'],
  }
}
