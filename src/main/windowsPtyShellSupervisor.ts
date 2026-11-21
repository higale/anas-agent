import { spawn, type ChildProcess } from 'node:child_process'
import { DetachedWindowsShellSupervisor } from './windowsDetachedShellSupervisor'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { terminalActionSchema, terminalInput, type TerminalAction, type TerminalSize } from '@shared/terminal'
import type { ShellTerminalControl } from './ptyShellSupervisor'

const nativeDependency = createRequire(import.meta.url)

// This supervisor stays OUTSIDE the console. The parent puts it in its
// Job before sending dispatch. Model Shells use an observation-only Job;
// dedicated tools retain their kill-on-close containment.
const program = String.raw`
const pty = require(process.env.ANAS_PTY_MODULE)
let terminal, request, startup, timeout, rootHandle, rootPoll, rootNative, pipeSocket
let aborted = false, timedOut = false
const rootOnly = process.env.ANAS_SHELL_ROOT_ONLY === '1'
let started = false, dispatched = false, ended = false, pressure = 0
const send = (message, callback) => {
  if (pipeSocket) return pipeSocket.write(JSON.stringify({ ...message, token: process.env.ANAS_SHELL_SUPERVISOR_TOKEN }) + '\n', callback)
  if (!process.connected) return false
  return process.send(message, callback)
}
const reportStarted = () => {
  if (!started && terminal && terminal.pid > 0) {
    started = true
    clearInterval(startup)
    if (rootOnly) {
      const native = require(process.env.ANAS_SHELL_NATIVE_MODULE), kernel = native.load('kernel32.dll')
      rootNative = {
        open: kernel.func('void * __stdcall OpenProcess(uint32_t, int, uint32_t)'),
        wait: kernel.func('uint32_t __stdcall WaitForSingleObject(void *, uint32_t)'),
        code: kernel.func('int __stdcall GetExitCodeProcess(void *, _Out_ uint32_t *)'),
        stop: kernel.func('int __stdcall TerminateProcess(void *, uint32_t)'),
        close: kernel.func('int __stdcall CloseHandle(void *)')
      }
      rootHandle = rootNative.open(0x101001, 0, terminal.pid)
      if (rootHandle) rootPoll = setInterval(() => {
        if (rootNative.wait(rootHandle, 0) !== 0) return
        const code = [0]
        clearInterval(rootPoll)
        if (rootNative.code(rootHandle, code)) setTimeout(() => finish(code[0]), 150)
        else finish(undefined, 'Could not read the Shell exit code.')
      }, 20)
    }
    send({ type: 'started', pid: terminal.pid })
  }
}
const finish = (exitCode, error) => {
  if (ended) return
  reportStarted()
  ended = true
  clearInterval(startup); clearTimeout(timeout); clearInterval(rootPoll)
  send({ type: 'result', exitCode, timedOut, aborted, beforeStart: !started, error }, () => { if (rootOnly) process.exit(0) })
  // Dedicated tools remain until their parent reclaims the containment Job.
}
const disconnected = () => { if (rootHandle) rootNative.stop(rootHandle, 1); process.exit(1) }
process.on('disconnect', disconnected)
const receive = (message) => {
  if (message.type === 'start' && !request && !ended) {
    request = message
    send({ type: 'dispatching' })
  } else if (message.type === 'dispatch' && request && !dispatched && !ended) {
    dispatched = true
    try {
      const size = JSON.parse(process.env.ANAS_PTY_SIZE)
      terminal = pty.spawn(request.executable, request.args, {
        cwd: request.cwd, env: request.environment, cols: size.columns, rows: size.rows, useConpty: true
      })
      terminal.onData((text) => {
        reportStarted()
        let blocked = false
        const accepted = send({ type: 'output', stream: 'stdout', text }, () => {
          if (blocked && --pressure === 0 && !ended) terminal.resume()
        })
        if (!accepted) { blocked = true; pressure++; terminal.pause() }
      })
      terminal.onExit(({ exitCode }) => finish(exitCode,
        Number.isSafeInteger(exitCode) ? undefined : 'ConPTY did not report a valid exit code.'))
      // node-pty connects asynchronously on Windows; pid is initially zero.
      // Do not require output before exposing control of a silent command.
      startup = setInterval(reportStarted, 10)
      reportStarted()
      if (request.timeoutMs > 0) timeout = setTimeout(() => {
        send({ type: 'termination_started', reason: 'timeout' })
      }, request.timeoutMs)
    } catch (error) { finish(undefined, error.message) }
  } else if (message.type === 'cancel' || message.type === 'termination_ack') {
    if (rootOnly) {
      aborted ||= message.type === 'cancel'; timedOut ||= message.type === 'termination_ack'
      if (rootHandle) rootNative.stop(rootHandle, 1)
      else if (!dispatched) finish(undefined)
      else send({ type: 'force_required', reason: aborted ? 'cancel' : 'timeout' })
    } else send({ type: 'force_required', reason: message.type === 'cancel' ? 'cancel' : 'timeout' })
  } else if (message.type === 'terminal_input') {
    try {
      if (!started || ended) throw new Error('The terminal instance is no longer available.')
      if (message.size) terminal.resize(message.size.columns, message.size.rows)
      else terminal.write(message.text)
      send({ type: 'terminal_ack', id: message.id })
    } catch (error) { send({ type: 'terminal_ack', id: message.id, error: error.message }) }
  }
}
if (process.env.ANAS_SHELL_SUPERVISOR_PIPE) {
  pipeSocket = require('node:net').createConnection(process.env.ANAS_SHELL_SUPERVISOR_PIPE)
  let input = ''
  pipeSocket.setEncoding('utf8')
  pipeSocket.on('data', chunk => {
    input += chunk
    if (input.length > 1000000) return disconnected()
    for (;;) {
      const boundary = input.indexOf('\n')
      if (boundary < 0) break
      const line = input.slice(0, boundary); input = input.slice(boundary + 1)
      try { receive(JSON.parse(line)) } catch { disconnected() }
    }
  })
  pipeSocket.once('connect', () => send({ type: 'ready', pid: process.pid }))
  pipeSocket.once('close', disconnected); pipeSocket.once('error', disconnected)
} else {
  process.on('message', receive)
  send({ type: 'ready', pid: process.pid })
}
`

export class WindowsPtyShellSupervisor extends EventEmitter implements ShellTerminalControl {
  readonly id = randomUUID()
  private readonly child: ChildProcess | DetachedWindowsShellSupervisor
  private dimensions: TerminalSize
  private ready = false
  private ended = false
  private inputBytes = 0
  private inputWrites = 0
  private readonly pending = new Map<string, { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }>()

  constructor(size: TerminalSize, rootOnly = false) {
    super()
    this.dimensions = { ...size }
    this.child = rootOnly ? new DetachedWindowsShellSupervisor(program, { ANAS_SHELL_ROOT_ONLY: '1',
      ANAS_SHELL_NATIVE_MODULE: nativeDependency.resolve('koffi'), ANAS_PTY_MODULE: nativeDependency.resolve('node-pty'), ANAS_PTY_SIZE: JSON.stringify(size) })
      : spawn(process.execPath, ['-e', program], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ANAS_PTY_MODULE: nativeDependency.resolve('node-pty'), ANAS_PTY_SIZE: JSON.stringify(size) }
    })
    this.child.on('message', (message: any) => {
      if (message.type === 'ready' && message.pid !== this.child.pid) {
        this.emit('error', new Error('Windows PTY supervisor identity mismatch.'))
        return
      }
      if (message.type === 'terminal_ack') {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(message.error))
        else pending.resolve()
        return
      }
      if (message.type === 'started') this.ready = true
      if (message.type === 'result') this.end()
      this.emit('message', message)
    })
    ;(this.child as EventEmitter).once('error', (error: Error) => { this.end(); this.emit('error', error) })
    ;(this.child as EventEmitter).once('exit', (code: number | null, signal: NodeJS.Signals | null) => { this.end(); this.emit('exit', code, signal) })
    if (this.child instanceof DetachedWindowsShellSupervisor) this.child.once('exit', () => this.end())
    else this.child.once('disconnect', () => this.end())
  }

  get pid(): number | undefined { return this.child.pid }
  get connected(): boolean { return this.child.connected }
  get exitCode(): number | null { return this.child.exitCode }
  get signalCode(): NodeJS.Signals | null { return this.child.signalCode }
  get size(): TerminalSize { return { ...this.dimensions } }
  send(message: any, callback?: (error: Error | null) => void): boolean { return this.child.send(message, callback) }
  disconnect(): void { this.child.disconnect() }
  kill(signal?: NodeJS.Signals | number): boolean { return this.child instanceof DetachedWindowsShellSupervisor ? this.child.kill() : this.child.kill(signal) }

  async apply(input: TerminalAction): Promise<void> {
    const action = terminalActionSchema.parse(input)
    if (!this.ready || this.ended || !this.connected) throw new Error('The terminal instance is no longer available.')
    if (this.pending.size >= 64) throw new Error('Too many pending terminal inputs.')
    const text = action.type === 'resize' ? undefined : terminalInput(action)
    if (text !== undefined) {
      const bytes = Buffer.byteLength(text, 'utf8')
      if (this.inputBytes + bytes > 1024 * 1024 || this.inputWrites >= 4096) throw new Error('Terminal input budget exhausted (1 MiB or 4096 writes per session). Use cancel_call to stop the session; bulk data belongs in files.')
      this.inputBytes += bytes
      this.inputWrites++
    }
    const id = randomUUID()
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(id)
        reject(error)
      }
      const timer = setTimeout(() => fail(new Error('Terminal input acknowledgement was lost; do not resend automatically.')), 5000)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ type: 'terminal_input', id, ...(action.type === 'resize' ? { size: { columns: action.columns, rows: action.rows } } : { text }) }, (error) => { if (error) fail(error) })
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
    })
    if (action.type === 'resize') this.dimensions = { columns: action.columns, rows: action.rows }
  }

  private end(): void {
    this.ended = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('The terminal ended before input acknowledgement; do not resend automatically.'))
    }
    this.pending.clear()
  }
}
