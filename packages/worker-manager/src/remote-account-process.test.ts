import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { buildRemoteAccountEnvironment, isRemoteAccountPaired, remoteAccountCredentialPath, remoteAccountSpawnSpec } from './remote-account-process'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('remote account process', () => {
  it('runs Desktop Commander remote through cmd.exe on Windows', () => {
    expect(remoteAccountSpawnSpec('win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' })).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'npx', '-y', '@wonderwhy-er/desktop-commander@latest', 'remote'],
    })
    expect(remoteAccountSpawnSpec('linux', {})).toEqual({ command: 'npx', args: ['-y', '@wonderwhy-er/desktop-commander@latest', 'remote'] })
  })

  it('isolates HOME, USERPROFILE, TEMP and TMP for each account profile', () => {
    const env = buildRemoteAccountEnvironment('D:/profiles/account-a', { PATH: 'x' })
    expect(env.USERPROFILE).toBe(resolve('D:/profiles/account-a/home'))
    expect(env.HOME).toBe(resolve('D:/profiles/account-a/home'))
    expect(env.TEMP).toBe(resolve('D:/profiles/account-a/temp'))
    expect(env.TMP).toBe(resolve('D:/profiles/account-a/temp'))
    expect(env.PATH).toBe('x')
  })

  it('detects pairing only from the profile-local RDC credential file', () => {
    const root = mkdtempSync(join(tmpdir(), 'dc-account-profile-')); roots.push(root)
    expect(remoteAccountCredentialPath(root)).toBe(resolve(join(root, 'home', '.desktop-commander-device', 'device.json')))
    expect(isRemoteAccountPaired(root)).toBe(false)
    mkdirSync(join(root, 'home', '.desktop-commander-device'), { recursive: true })
    writeFileSync(remoteAccountCredentialPath(root), '{}')
    expect(isRemoteAccountPaired(root)).toBe(true)
  })
})
