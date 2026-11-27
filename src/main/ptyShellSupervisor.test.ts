import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { beforeEach, expect, it, vi } from 'vitest'
import { PtyShellSupervisor } from './ptyShellSupervisor'

const probe = vi.hoisted(() => ({
  inspect: vi.fn(), terminate: vi.fn(), signalMember: vi.fn(),
  accept: undefined as ((socket: Socket) => void) | undefined,
  exit: undefined as ((event: { exitCode: number }) => void) | undefined
}))
vi.mock('./posixPtySession', () => ({ createPosixPtySession: () => probe }))
vi.mock('node:net', () => ({
  createServer: (accept: (socket: Socket) => void) => {
    probe.accept = accept
    return {
      once() { return this },
      listen(_path: string, ready: () => void) { queueMicrotask(ready); return this },
      close(done: () => void) { done(); return this }
    }
  }
}))
vi.mock('node-pty', () => ({
  spawn: () => ({ pid: 64, onData: vi.fn(), onExit: (exit: typeof probe.exit) => { probe.exit = exit } })
}))

beforeEach(() => {
  probe.inspect.mockReturnValue({ pid: 64, session: 64, birth: '100:0', stopped: false, zombie: false })
  probe.terminate.mockReturnValue(true)
  probe.signalMember.mockReturnValue(true)
})

async function fixture() {
  const supervisor = new PtyShellSupervisor('', { columns: 80, rows: 24 })
  const error = vi.fn(), exit = vi.fn()
  supervisor.on('error', error)
  supervisor.on('exit', exit)
  await Promise.resolve()
  const socket = Object.assign(new EventEmitter(), { setEncoding: vi.fn(), destroy: vi.fn() })
  probe.accept!(socket as unknown as Socket)
  return { supervisor, socket, error, exit }
}

it('preserves confirmed forced termination across control-pipe close and terminal exit', async () => {
  const { supervisor, socket, error, exit } = await fixture()
  try {
    expect(supervisor.kill('SIGKILL')).toBe(true)
    // Kernel metadata can disappear while the killed processes are being reaped.
    probe.terminate.mockReturnValue(false)
    probe.signalMember.mockReturnValue(false)
    socket.emit('close')
    expect(error).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  } finally { probe.exit!({ exitCode: 0 }) }
  expect(exit).toHaveBeenCalledExactlyOnceWith(0, null)
  expect(error).not.toHaveBeenCalled()
  expect(supervisor.kill('SIGKILL')).toBe(true)
})

it.each([false, true])('reports unconfirmed cleanup after disconnect even if graceful termination succeeded: %s', async (graceful) => {
  const { supervisor, socket, error } = await fixture()
  try {
    if (graceful) expect(supervisor.kill('SIGTERM')).toBe(true)
    probe.terminate.mockReturnValue(false)
    probe.signalMember.mockReturnValue(false)
    expect(supervisor.kill('SIGKILL')).toBe(false)
    socket.emit('close')
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'Could not contain the disconnected PTY supervisor.' }))
  } finally { probe.exit!({ exitCode: 0 }) }
  expect(supervisor.kill('SIGKILL')).toBe(false)
})
