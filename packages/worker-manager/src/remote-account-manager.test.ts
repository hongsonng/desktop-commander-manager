import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase } from '@dc-manager/database'
import type { RemoteAccountExit, RemoteAccountProcessFactory, RemoteAccountProcessHandle } from './remote-account-process'
import { RemoteAccountManager } from './remote-account-manager'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

class FakeRemoteProcesses implements RemoteAccountProcessFactory {
  nextPid = 700
  starts: Array<{ accountId: string; profileDir: string; pid: number }> = []
  startRequests: string[] = []
  stops: string[] = []
  private exits = new Map<string, (exit: RemoteAccountExit) => void>()
  private gates = new Map<string, Promise<void>>()

  delayStart(accountId: string): () => void {
    let release!: () => void
    this.gates.set(accountId, new Promise<void>((resolve) => { release = resolve }))
    return release
  }

  async start(accountId: string, profileDir: string): Promise<RemoteAccountProcessHandle> {
    this.startRequests.push(accountId)
    await this.gates.get(accountId)
    const pid = this.nextPid++
    let resolveExit!: (exit: RemoteAccountExit) => void
    const exited = new Promise<RemoteAccountExit>((resolve) => { resolveExit = resolve })
    this.exits.set(accountId, resolveExit)
    this.starts.push({ accountId, profileDir, pid })
    return {
      pid,
      exited,
      stop: async () => {
        this.stops.push(accountId)
        resolveExit({ code: 0, signal: null })
      },
    }
  }

  crash(accountId: string): void {
    this.exits.get(accountId)?.({ code: 1, signal: null })
  }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dc-remote-accounts-')); roots.push(root)
  const db = createDatabase(join(root, 'manager.db'))
  const processes = new FakeRemoteProcesses()
  const manager = new RemoteAccountManager({ database: db, processFactory: processes, profileRoot: join(root, 'profiles'), isPaired: (profileDir) => profileDir.endsWith('account-a') })
  return { root, db, processes, manager }
}

describe('RemoteAccountManager', () => {
  it('creates isolated account profiles and reports pairing without reading credentials', () => {
    const { db, manager } = setup()
    const a = manager.addAccount('Account A', 'account-a')
    const b = manager.addAccount('Account B', 'account-b')
    expect(a.profileDir).not.toBe(b.profileDir)
    expect(manager.listAccounts()).toEqual([
      expect.objectContaining({ id: 'account-a', paired: true, status: 'STOPPED' }),
      expect.objectContaining({ id: 'account-b', paired: false, status: 'STOPPED' }),
    ])
    db.close()
  })

  it('activates one account at a time and rotates round-robin across enabled accounts', async () => {
    const { db, manager, processes } = setup()
    manager.addAccount('Account A', 'account-a')
    manager.addAccount('Account B', 'account-b')
    manager.addAccount('Account C', 'account-c')

    await manager.activateAccount('account-a')
    expect(manager.listAccounts().find((item) => item.id === 'account-a')).toMatchObject({ status: 'RUNNING', pid: 700 })

    const next = await manager.rotateAccount()
    expect(next.id).toBe('account-b')
    expect(processes.stops).toEqual(['account-a'])
    expect(manager.listAccounts().find((item) => item.id === 'account-b')).toMatchObject({ status: 'RUNNING', pid: 701 })

    await manager.disableAccount('account-c')
    const wrapped = await manager.rotateAccount()
    expect(wrapped.id).toBe('account-a')
    expect(processes.stops).toEqual(['account-a', 'account-b'])
    await manager.close(); db.close()
  })

  it('serializes concurrent activation so only one remote account process can remain active', async () => {
    const { db, manager, processes } = setup()
    manager.addAccount('Account A', 'account-a')
    manager.addAccount('Account B', 'account-b')
    const releaseA = processes.delayStart('account-a')

    const activateA = manager.activateAccount('account-a')
    await Promise.resolve()
    const activateB = manager.activateAccount('account-b')
    await Promise.resolve()
    expect(processes.startRequests).toEqual(['account-a'])

    releaseA()
    await Promise.all([activateA, activateB])
    expect(processes.startRequests).toEqual(['account-a', 'account-b'])
    expect(processes.stops).toEqual(['account-a'])
    expect(manager.listAccounts().find((item) => item.id === 'account-a')).toMatchObject({ status: 'STOPPED', pid: null })
    expect(manager.listAccounts().find((item) => item.id === 'account-b')).toMatchObject({ status: 'RUNNING', pid: 701 })
    await manager.close(); db.close()
  })

  it('marks an unexpectedly exited active account as error', async () => {
    const { db, manager, processes } = setup()
    manager.addAccount('Account A', 'account-a')
    await manager.activateAccount('account-a')
    processes.crash('account-a')
    await Promise.resolve(); await Promise.resolve()
    expect(manager.listAccounts().find((item) => item.id === 'account-a')).toMatchObject({ status: 'ERROR', pid: null })
    db.close()
  })
})
