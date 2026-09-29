// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from './App'
import * as api from './api'

vi.mock('./api', () => ({
  getHealth: vi.fn(), getWorkers: vi.fn(), getSessions: vi.fn(), getEvents: vi.fn(), workerAction: vi.fn(),
}))

const now = '2026-09-29T00:00:00.000Z'

beforeEach(() => {
  vi.mocked(api.getHealth).mockResolvedValue({ status: 'ok', startedAt: now, uptimeMs: 12345 })
  vi.mocked(api.getWorkers).mockResolvedValue([
    { id: 'worker-1', name: 'Worker 1', enabled: true, status: 'READY', pid: 101, failureCount: 0, lastHeartbeatAt: now, createdAt: now, updatedAt: now, activeSessionCount: 3 },
    { id: 'worker-2', name: 'Worker 2', enabled: false, status: 'DISABLED', pid: null, failureCount: 1, lastHeartbeatAt: null, createdAt: now, updatedAt: now, activeSessionCount: 0 },
  ])
  vi.mocked(api.getSessions).mockResolvedValue([{ sessionId: 'chat-a', workerId: 'worker-1', createdAt: now, lastUsedAt: now }])
  vi.mocked(api.getEvents).mockResolvedValue([{ id: 1, sessionId: 'chat-a', workerId: 'worker-1', type: 'SESSION_FAILOVER', message: 'worker-2 -> worker-1', metadataJson: null, createdAt: now }])
  vi.mocked(api.workerAction).mockResolvedValue(undefined)
})

describe('dashboard', () => {
  it('renders manager state and executes worker actions with refresh', async () => {
    const user = userEvent.setup(); render(<App />)
    expect(await screen.findByText('Desktop Commander Manager')).toBeTruthy()
    expect(await screen.findByText('Worker 1')).toBeTruthy()
    expect(screen.getByText('3 sessions')).toBeTruthy()
    expect(screen.getByText('chat-a')).toBeTruthy()
    expect(screen.getByText('SESSION_FAILOVER')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Restart Worker 1' }))
    await waitFor(() => expect(api.workerAction).toHaveBeenCalledWith('worker-1', 'restart'))
    await user.click(screen.getByRole('button', { name: 'Disable Worker 1' }))
    await waitFor(() => expect(api.workerAction).toHaveBeenCalledWith('worker-1', 'disable'))
    await user.click(screen.getByRole('button', { name: 'Enable Worker 2' }))
    await waitFor(() => expect(api.workerAction).toHaveBeenCalledWith('worker-2', 'enable'))
    expect(vi.mocked(api.getWorkers).mock.calls.length).toBeGreaterThan(1)
  })

  it('shows a recoverable error state when refresh fails', async () => {
    vi.mocked(api.getHealth).mockRejectedValueOnce(new Error('network down'))
    render(<App />)
    expect(await screen.findByRole('alert')).toHaveTextContent('network down')
  })
})

