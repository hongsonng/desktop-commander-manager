import { join, resolve } from 'node:path'
import type { ManagerDatabase } from '@dc-manager/database'
import type { RemoteAccountRecord } from '@dc-manager/shared'
import { isRemoteAccountPaired, type RemoteAccountExit, type RemoteAccountProcessFactory, type RemoteAccountProcessHandle } from './remote-account-process.js'

export type RemoteAccountView = RemoteAccountRecord & { paired: boolean }

type RemoteAccountManagerOptions = {
  database: ManagerDatabase
  processFactory: RemoteAccountProcessFactory
  profileRoot: string
  isPaired?: (profileDir: string) => boolean
}

export class RemoteAccountManager {
  private readonly handles = new Map<string, RemoteAccountProcessHandle>()
  private readonly intentionalStops = new Set<string>()
  private readonly profileRoot: string
  private readonly pairedCheck: (profileDir: string) => boolean
  private lifecycleQueue: Promise<void> = Promise.resolve()

  constructor(private readonly options: RemoteAccountManagerOptions) {
    this.profileRoot = resolve(options.profileRoot)
    this.pairedCheck = options.isPaired ?? isRemoteAccountPaired
  }

  addAccount(name: string, id: string): RemoteAccountRecord {
    const normalizedId = id.trim().toLowerCase()
    const normalizedName = name.trim()
    if (!normalizedId || !/^[a-z0-9][a-z0-9_-]*$/.test(normalizedId)) throw new Error('Account id must contain only letters, numbers, hyphen, or underscore')
    if (!normalizedName) throw new Error('Account name is required')
    if (this.options.database.remoteAccounts.getAccount(normalizedId)) throw new Error(`Remote account already exists: ${normalizedId}`)
    const now = new Date().toISOString()
    const account: RemoteAccountRecord = {
      id: normalizedId,
      name: normalizedName,
      enabled: true,
      status: 'STOPPED',
      pid: null,
      profileDir: resolve(join(this.profileRoot, normalizedId)),
      lastStartedAt: null,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    this.options.database.remoteAccounts.upsertAccount(account)
    this.event(normalizedId, 'REMOTE_ACCOUNT_ADDED', `Added remote account ${normalizedName}`)
    return account
  }

  listAccounts(): RemoteAccountView[] {
    return this.options.database.remoteAccounts.listAccounts().map((account) => ({ ...account, paired: this.pairedCheck(account.profileDir) }))
  }

  activateAccount(id: string): Promise<RemoteAccountRecord> {
    return this.runLifecycle(() => this.activateAccountUnlocked(id))
  }

  stopAccount(id: string): Promise<RemoteAccountRecord> {
    return this.runLifecycle(() => this.stopAccountUnlocked(id))
  }

  disableAccount(id: string): Promise<RemoteAccountRecord> {
    return this.runLifecycle(() => this.disableAccountUnlocked(id))
  }

  enableAccount(id: string): Promise<RemoteAccountRecord> {
    return this.runLifecycle(() => this.enableAccountUnlocked(id))
  }

  rotateAccount(): Promise<RemoteAccountRecord> {
    return this.runLifecycle(async () => {
      const eligible = this.options.database.remoteAccounts.listAccounts().filter((account) => account.enabled && account.status !== 'DISABLED')
      if (eligible.length === 0) throw new Error('No enabled remote accounts')
      const runningId = [...this.handles.keys()][0]
      const currentIndex = runningId ? eligible.findIndex((account) => account.id === runningId) : -1
      const next = eligible[currentIndex >= 0 ? (currentIndex + 1) % eligible.length : 0]
      return this.activateAccountUnlocked(next.id)
    })
  }

  close(): Promise<void> {
    return this.runLifecycle(async () => {
      for (const id of [...this.handles.keys()]) await this.stopAccountUnlocked(id).catch(() => undefined)
    })
  }

  private runLifecycle<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.lifecycleQueue.then(operation, operation)
    this.lifecycleQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private async activateAccountUnlocked(id: string): Promise<RemoteAccountRecord> {
    const current = this.requireAccount(id)
    if (!current.enabled || current.status === 'DISABLED') throw new Error(`Remote account is disabled: ${id}`)

    for (const runningId of [...this.handles.keys()]) {
      if (runningId !== id) await this.stopAccountUnlocked(runningId)
    }

    const existing = this.handles.get(id)
    if (existing) {
      const now = new Date().toISOString()
      const updated = { ...this.requireAccount(id), status: 'RUNNING' as const, pid: existing.pid, lastUsedAt: now, updatedAt: now }
      this.options.database.remoteAccounts.upsertAccount(updated)
      return updated
    }

    const startingAt = new Date().toISOString()
    this.options.database.remoteAccounts.upsertAccount({ ...current, status: 'STARTING', pid: null, updatedAt: startingAt })
    this.event(id, 'REMOTE_ACCOUNT_STARTING', `Starting remote account ${current.name}`)
    try {
      const handle = await this.options.processFactory.start(id, current.profileDir)
      this.handles.set(id, handle)
      const runningAt = new Date().toISOString()
      const running: RemoteAccountRecord = {
        ...current,
        status: 'RUNNING',
        pid: handle.pid,
        lastStartedAt: runningAt,
        lastUsedAt: runningAt,
        updatedAt: runningAt,
      }
      this.options.database.remoteAccounts.upsertAccount(running)
      this.event(id, 'REMOTE_ACCOUNT_RUNNING', `Remote account ${current.name} is running`)
      void handle.exited.then((exit) => this.onUnexpectedExit(id, handle, exit))
      return running
    } catch (error) {
      const failedAt = new Date().toISOString()
      this.options.database.remoteAccounts.upsertAccount({ ...current, status: 'ERROR', pid: null, updatedAt: failedAt })
      this.event(id, 'REMOTE_ACCOUNT_START_FAILED', error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  private async stopAccountUnlocked(id: string): Promise<RemoteAccountRecord> {
    const current = this.requireAccount(id)
    await this.stopHandle(id)
    const now = new Date().toISOString()
    const stopped: RemoteAccountRecord = { ...this.requireAccount(id), status: current.enabled ? 'STOPPED' : 'DISABLED', pid: null, updatedAt: now }
    this.options.database.remoteAccounts.upsertAccount(stopped)
    this.event(id, 'REMOTE_ACCOUNT_STOPPED', `Stopped remote account ${current.name}`)
    return stopped
  }

  private async disableAccountUnlocked(id: string): Promise<RemoteAccountRecord> {
    const current = this.requireAccount(id)
    await this.stopHandle(id)
    const now = new Date().toISOString()
    const disabled: RemoteAccountRecord = { ...current, enabled: false, status: 'DISABLED', pid: null, updatedAt: now }
    this.options.database.remoteAccounts.upsertAccount(disabled)
    this.event(id, 'REMOTE_ACCOUNT_DISABLED', `Disabled remote account ${current.name}`)
    return disabled
  }

  private enableAccountUnlocked(id: string): RemoteAccountRecord {
    const current = this.requireAccount(id)
    const now = new Date().toISOString()
    const enabled: RemoteAccountRecord = { ...current, enabled: true, status: 'STOPPED', pid: null, updatedAt: now }
    this.options.database.remoteAccounts.upsertAccount(enabled)
    this.event(id, 'REMOTE_ACCOUNT_ENABLED', `Enabled remote account ${current.name}`)
    return enabled
  }

  private async stopHandle(id: string): Promise<void> {
    const handle = this.handles.get(id)
    if (!handle) return
    this.intentionalStops.add(id)
    try { await handle.stop() } finally {
      this.handles.delete(id)
      this.intentionalStops.delete(id)
    }
  }

  private requireAccount(id: string): RemoteAccountRecord {
    const account = this.options.database.remoteAccounts.getAccount(id)
    if (!account) throw new Error(`Unknown remote account: ${id}`)
    return account
  }

  private onUnexpectedExit(id: string, handle: RemoteAccountProcessHandle, exit: RemoteAccountExit): void {
    if (this.handles.get(id) !== handle) return
    this.handles.delete(id)
    if (this.intentionalStops.delete(id)) return
    const current = this.options.database.remoteAccounts.getAccount(id)
    if (!current) return
    const now = new Date().toISOString()
    this.options.database.remoteAccounts.upsertAccount({ ...current, status: 'ERROR', pid: null, updatedAt: now })
    this.event(id, 'REMOTE_ACCOUNT_EXIT', `Remote account ${current.name} exited unexpectedly`, { code: exit.code, signal: exit.signal })
  }

  private event(accountId: string, type: string, message: string, metadata?: unknown): void {
    this.options.database.events.appendEvent({
      sessionId: null,
      workerId: null,
      type,
      message,
      metadataJson: JSON.stringify({ accountId, ...(metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : {}) }),
      createdAt: new Date().toISOString(),
    })
  }
}
