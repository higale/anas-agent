import { describe, expect, it } from 'vitest'
import { runPreparedProcess, runShellCommand, type ShellRunResult } from './shellRuntime'
import { inspectProcess, refreshProcesses, terminateObservedProcess } from './processObservation'
import type { ProcessIdentity } from '@shared/processes'
import { nativeCapabilityFixture } from '../test/nativeCapabilityFixture'

const invocation = (source: string) => ({ executable: process.execPath, args: ['-e', source], windowsHide: true,
  env: { ELECTRON_RUN_AS_NODE: '1' } })
const prepared = (source: string, timeoutSec = 0) => ({ command: source, workingDir: process.cwd(), timeoutSec, rootOnly: true,
  invocation: invocation(source), logScope: 'test', logResult: false, successMessage: 'done', failureMessage: 'failed',
  abortBeforeStartError: 'cancelled before start', abortError: 'cancelled', timeoutError: 'timeout' })
const childSource = `setInterval(() => {}, 1000)`
function source(wait: boolean, pipes = false) {
  return `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], {
    detached: true, windowsHide: true, env: {...process.env, ELECTRON_RUN_AS_NODE:'1'}, stdio: ${pipes ? "['ignore', process.stdout, process.stderr]" : "'ignore'"}
  }); console.log(c.pid); c.unref(); ${wait ? 'setInterval(() => {}, 1000)' : 'setTimeout(() => process.exit(0), 800)'}`
}
async function cleanup(pid: number | undefined) {
  if (!pid) return
  const info = inspectProcess(pid)
  if (info) terminateObservedProcess({ ...info, role: 'child' })
}
describe('model Shell process ownership', () => {
  it.runIf(process.platform === 'win32').each(['fixture-search-path', ''])('passes the canonical Windows PATH even with an inherited Path alias (%j)', async path => {
    const script = "process.stdout.write('PATH=' + process.env.PATH + ';CASE=' + process.env.ANAS_CASE)"
    const result = await runPreparedProcess({ ...prepared(script), invocation: { ...invocation(script), env: {
      ELECTRON_RUN_AS_NODE: '1', Path: 'stale-search-path', PATH: path, anas_case: 'stale', ANAS_CASE: 'canonical'
    } } })
    expect(result).toBe(`PATH=${path};CASE=canonical`)
  })

  it('rechecks completed call children for read and wait without changing recorded outcomes', async () => {
    const h = nativeCapabilityFixture()
    let pid: number | undefined, callId = ''
    try {
      const result = JSON.parse(await h.service.start({ kind: 'shell', threadId: h.thread.id, runId: h.run.id,
        summary: 'Observe live child', execute: async control => {
          callId = control.callId
          return runPreparedProcess(prepared(source(false)), control.signal, {
            onDispatched: control.markRunning,
            onOutput: (_stream, text) => { if (/^\d+\s*$/.test(text)) pid = Number(text) },
            onResult: result => control.setOutcome({ ok: result.ok, exit_code: result.exitCode, process_snapshot: result.process_snapshot })
          })
        } }))
      expect(result.remaining_processes).toContainEqual(expect.objectContaining({ pid }))
      const original = h.database.managed.getManagedCall(callId, h.thread.id)!.outcome!
      const read = () => JSON.parse(h.service.read({ callId, threadId: h.thread.id }))
      expect(read().outcome.remaining_processes).toEqual(result.remaining_processes)
      const snapshot = original.process_snapshot as NonNullable<ShellRunResult['process_snapshot']>
      h.database.managed.updateManagedCallOutcome(callId, h.thread.id, { ...original, process_snapshot: {
        ...snapshot, processes: snapshot.processes.map(info => info.pid === pid ? { ...info, birth: 'stale identity' } : info)
      } })
      expect(inspectProcess(pid!)?.pid).toBe(pid)
      expect(read().outcome).not.toHaveProperty('remaining_processes')
      h.database.managed.updateManagedCallOutcome(callId, h.thread.id, original)
      await cleanup(pid)
      await expect.poll(() => inspectProcess(pid!)).toBeUndefined()
      for (const value of [read(), JSON.parse(await h.service.wait({ callId, threadId: h.thread.id }))]) {
        expect(value).toMatchObject({ status: 'completed', outcome: { ok: true, exit_code: 0 } })
        expect(value.outcome).not.toHaveProperty('remaining_processes')
        expect(value.outcome).not.toHaveProperty('process_snapshot')
      }
      expect(h.database.managed.getManagedCall(callId, h.thread.id)?.outcome).toEqual(original)
    } finally { await cleanup(pid); await h.close() }
  }, 20000)
  it('completes on root exit while retaining and reporting a live child that inherited output pipes', async () => {
    let pid: number | undefined
    try {
      let outcome: ShellRunResult | undefined
      const result = JSON.parse(await runPreparedProcess(prepared(source(false, true)), undefined,
        { onResult: value => { outcome = value } }))
      pid = Number(result.stdout.trim())
      expect(result.error).toBeUndefined()
      expect(outcome?.exitCode).toBe(0)
      expect(pid).toBeGreaterThan(1)
      expect(inspectProcess(pid!)?.pid).toBe(pid)
      expect(result.remaining_processes).toEqual(expect.arrayContaining([expect.objectContaining({ pid })]))
      expect(result.process_snapshot).toBeUndefined()
      expect(outcome?.process_snapshot?.complete).toBe(false)
    } finally { await cleanup(pid) }
  }, 20000)
  it('reports only the application launched by the Shell, excluding its own helper processes', async () => {
    let application: number | undefined, helper: number | undefined
    const applicationSource = `const helper = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true, windowsHide: true, stdio: 'ignore', env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}
    }); helper.unref(); process.send({ application: process.pid, helper: helper.pid }); setInterval(() => {}, 1000)`
    const rootSource = `const app = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(applicationSource)}], {
      detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}
    }); app.once('message', message => { console.log(JSON.stringify(message)); app.disconnect(); app.unref(); setTimeout(() => process.exit(0), 800) })`
    try {
      let outcome: ShellRunResult | undefined
      const result = JSON.parse(await runPreparedProcess(prepared(rootSource), undefined, {
        onOutput: (_stream, text) => { const pids = JSON.parse(text); application = pids.application; helper = pids.helper },
        onResult: value => { outcome = value }
      }))
      expect(result.ok).toBe(true)
      const root = outcome!.process_snapshot!.processes.find(info => info.role === 'shell')!
      expect(result.remaining_processes).toEqual([{ pid: application, name: inspectProcess(application!)!.name }])
      expect(outcome!.process_snapshot!.processes.some(info => info.pid === helper)).toBe(false)
      expect(inspectProcess(helper!)?.pid).toBe(helper)
      const app = outcome!.process_snapshot!.processes.find(info => info.pid === application)!
      const helperIdentity: ProcessIdentity = { ...inspectProcess(helper!)!, parentPid: application!, role: 'child' }
      const recorded = [...outcome!.process_snapshot!.processes, helperIdentity]
      expect(refreshProcesses(recorded).processes.some(info => info.pid === helper)).toBe(false)
      if (process.platform === 'win32') {
        const old = recorded.map(info => ({ ...info, parentPid: 0 }))
        const refreshed = refreshProcesses(old)
        expect(refreshed.processes).toContainEqual(expect.objectContaining({ pid: application, parentPid: root.pid }))
        expect(refreshed.processes.some(info => info.pid === helper)).toBe(false)
      }
      terminateObservedProcess(app)
      await expect.poll(() => inspectProcess(application!)).toBeUndefined()
      expect(inspectProcess(helper!)?.pid).toBe(helper)
      expect(refreshProcesses(recorded).processes.some(info => info.pid === helper)).toBe(false)
    } finally { await cleanup(application); await cleanup(helper) }
  }, 20000)
  it.each(['cancel', 'timeout'] as const)('%s stops the root while preserving its child', async mode => {
    const controller = new AbortController()
    let pid: number | undefined, root: ProcessIdentity | undefined
    try {
      const result = JSON.parse(await runPreparedProcess(prepared(source(true), mode === 'timeout' ? 1 : 0), controller.signal, {
        onOutput: (_stream, text) => { if (/^\d+\s*$/.test(text)) { pid = Number(text); if (mode === 'cancel') controller.abort() } },
        onProcesses: snapshot => { root ??= snapshot.processes.find(info => info.role === 'shell') }
      })) as ShellRunResult
      expect(mode === 'timeout' ? result.timedOut : result.aborted).toBe(true)
      expect(root).toBeDefined()
      expect(inspectProcess(root!.pid)).toBeUndefined()
      expect(inspectProcess(pid!)?.pid).toBe(pid)
    } finally { await cleanup(pid); await cleanup(root?.pid) }
  }, 20000)
  it('still stops the owned root if process metadata persistence fails', async () => {
    let pid: number | undefined, root: ProcessIdentity | undefined, uncertain = ''
    try {
      const result = JSON.parse(await runPreparedProcess(prepared(source(true)), undefined, {
        onOutput: (_stream, text) => { if (/^\d+\s*$/.test(text)) pid = Number(text) },
        onProcesses: snapshot => {
          root ??= snapshot.processes.find(info => info.role === 'shell')
          if (pid) throw new Error('metadata write failed')
        },
        onOutcomeUncertain: reason => { uncertain = reason }
      })) as ShellRunResult
      expect(result.ok).toBe(false)
      expect(uncertain).toContain('metadata write failed')
      expect(root).toBeDefined()
      expect(inspectProcess(root!.pid)).toBeUndefined()
      expect(inspectProcess(pid!)?.pid).toBe(pid)
    } finally { await cleanup(pid); await cleanup(root?.pid) }
  }, 20000)
  it('drains large UTF-8 output without losing persisted chunks while bounding the inline result', async () => {
    let output = ''
    const value = '中文🙂'.repeat(70000)
    const result = JSON.parse(await runPreparedProcess(prepared('process.stdout.write("中文🙂".repeat(70000))'), undefined,
      { onOutput: (stream, text) => { if (stream === 'stdout') output += text } })) as ShellRunResult
    expect(result.ok).toBe(true)
    expect(output).toBe(value)
    expect(result.stdout.length).toBeLessThan(value.length)
    expect(result.truncated?.stdout).toBe(true)
  }, 20000)
  it('rejects termination of a reused or stale process identity', () => {
    const info = inspectProcess(process.pid)!
    expect(() => terminateObservedProcess({ ...info, role: 'child', birth: 'invalid' })).toThrow('identity')
    expect(refreshProcesses([{ ...info, role: 'shell', birth: 'invalid' }]).processes[0].status).toBe('exited')
  })
  it('returns native Shell UTF-8 output while retaining root identity internally', async () => {
    let outcome: ShellRunResult | undefined
    const windows = process.platform === 'win32'
    const result = await runShellCommand({ command: windows ? 'Write-Output "hello 中文"' : "printf 'hello 中文\\n'",
      workingDir: process.cwd(), timeoutSec: 0 }, windows
      ? { executable: 'pwsh.exe', name: 'PowerShell', family: 'powershell' }
      : { executable: process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh', name: 'Shell', family: 'posix' },
    undefined, { onResult: value => { outcome = value } })
    expect(outcome?.error).toBeUndefined()
    expect(result.trim()).toBe('hello 中文')
    expect(outcome?.process_snapshot?.processes.some(info => info.role === 'shell')).toBe(true)
  }, 20000)
})

it('supports input and preserves detached children when a model PTY Shell ends', async () => {
  const executable = process.platform === 'win32' ? process.env.npm_node_execpath! : process.execPath
  let pid: number | undefined, terminal: import('./ptyShellSupervisor').ShellTerminalControl | undefined
  let outcome: ShellRunResult | undefined, output = ''
  const controller = new AbortController()
  const script = source(true).replace('console.log(c.pid)', "console.log('CHILD_PID=' + c.pid)").replace('c.unref(); setInterval(() => {}, 1000)',
    "c.unref(); process.stdin.setEncoding('utf8'); console.log('READY'); process.stdin.once('data',()=>{console.log('RECEIVED'); process.exit(0)})")
  const completion = runPreparedProcess({ ...prepared(script, 8), pty: { columns: 90, rows: 25 },
    invocation: { ...invocation(script), executable } }, controller.signal, {
    onTerminal: value => { terminal = value },
    onResult: value => { outcome = value },
    onProcesses: value => { pid ??= value.processes.find(info => info.role === 'child' && info.name.toLowerCase().includes('node'))?.pid },
    onOutput: (_stream, text) => {
      output += text
      const match = output.match(/CHILD_PID=(\d+)/)
      if (match) pid = Number(match[1])
      if (text.includes('READY')) setTimeout(() => { void terminal?.apply({ type: 'text', text: 'continue\r' }) }, 100)
    }
  })
  try {
    expect(await completion).toContain('RECEIVED')
    expect(outcome).toMatchObject({ ok: true, exitCode: 0 })
    expect(outcome?.error).toBeUndefined()
    expect(outcome?.stdout).toContain('RECEIVED')
    expect(pid).toBeGreaterThan(1)
    expect(inspectProcess(pid!)?.pid).toBe(pid)
  } finally { controller.abort(); await completion; await cleanup(pid) }
}, 20000)
