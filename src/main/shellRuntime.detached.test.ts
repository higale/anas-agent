import { randomUUID } from 'node:crypto'
import { toolEffectArtifactPurposes, type ToolEffectArtifactIdentity } from '../runtime/toolEffectIdentity'
import { nativeCapabilityFixture } from '../test/nativeCapabilityFixture'
import { ChildProcess, execFileSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./config/apiKeys', () => ({ loadDataEnv: vi.fn() }))
vi.mock('./runtimeLogger', () => ({ runtimeLog: vi.fn() }))

import { runPreparedProcess, runShellCommand, type PreparedProcess, type ShellRunResult } from './shellRuntime'
import { DetachedWindowsShellSupervisor } from './windowsDetachedShellSupervisor'
import { runWithCurrentAgentToolEffect } from './agent/toolEffectScope'

function prepared(command: string, workingDir: string): PreparedProcess {
  return {
    command, workingDir, timeoutSec: 0, keepProcesses: true,
    invocation: { executable: process.execPath, args: ['-e', command], windowsHide: true,
      env: { ELECTRON_RUN_AS_NODE: '1' } },
    logScope: 'test', successMessage: 'Independent launch confirmed.', failureMessage: 'Launch failed.',
    abortBeforeStartError: 'Cancelled before start.', abortError: 'Cancelled.', timeoutError: 'Timed out.'
  }
}

async function cleanup(root: string, result?: ShellRunResult): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  if (result?.detached) await rm(dirname(result.detached.stdoutPath), {
    recursive: true, force: true, maxRetries: 20, retryDelay: 100
  })
}

describe('independent shell processes', () => {
  it('returns before a foreground command finishes and survives later cancellation and service shutdown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-independent-'))
    const proceed = join(root, 'continue')
    const completed = join(root, 'completed')
    const h = nativeCapabilityFixture(), { database, service, thread, run } = h
    const scope = { identity: { runId: run.id,
      artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, randomUUID()])) as ToolEffectArtifactIdentity['artifacts'] }, arm: vi.fn() }
    const controller = new AbortController()
    let result: ShellRunResult | undefined
    try {
      const command = `
        const fs = require('node:fs');
        process.stdout.write('ready 中文');
        const deadline = setTimeout(() => process.exit(2), 12000);
        const poll = setInterval(() => {
          if (!fs.existsSync(${JSON.stringify(proceed)})) return;
          clearInterval(poll); clearTimeout(deadline);
          process.stdout.write(' survived'); process.stderr.write('stderr 中文');
          fs.writeFileSync(${JSON.stringify(completed)}, 'done');
        }, 20);
      `
      result = JSON.parse(await runWithCurrentAgentToolEffect(scope, () => service.start({ kind: 'shell', threadId: thread.id, runId: run.id,
        summary: 'Start independent foreground command', parentSignal: controller.signal,
        execute: control => runPreparedProcess(prepared(command, root), control.signal, {
          onDispatched: control.markRunning,
          onResult: outcome => {
            control.setOutcome({ ok: outcome.ok, ...(outcome.detached ? { local_commit_completed: true } : {}) })
            // Exercise cancellation at the handoff boundary, before the
            // managed executor's completion promise has settled.
            controller.abort()
          }
        }) }))) as ShellRunResult
      expect(result).toMatchObject({ ok: true, detached: { pid: expect.any(Number),
        stdoutPath: expect.any(String), stderrPath: expect.any(String) } })
      expect(result.exitCode).toBeUndefined()
      expect(service.hasActiveForThread(thread.id)).toBe(false)
      expect(database.managed.getManagedCall(scope.identity.artifacts['managed-call'], thread.id))
        .toMatchObject({ status: 'completed', outcome: { ok: true, local_commit_completed: true } })
      const replayExecute = vi.fn(async () => 'must not relaunch')
      const replay = await runWithCurrentAgentToolEffect(scope, () => service.start({
        kind: 'shell', threadId: thread.id, runId: run.id, summary: 'Replay launch', execute: replayExecute
      }))
      expect(JSON.parse(replay)).toEqual(result)
      expect(replayExecute).not.toHaveBeenCalled()
      await expect(access(completed)).rejects.toMatchObject({ code: 'ENOENT' })
      await service.cancelThreads([thread.id], 'Later conversation cleanup')
      await service.shutdown()
      await writeFile(proceed, '')
      await vi.waitFor(async () => expect(await readFile(completed, 'utf8')).toBe('done'), { timeout: 5_000 })
      expect(await readFile(result.detached!.stdoutPath, 'utf8')).toBe('ready 中文 survived')
      // Electron can prepend native macOS startup diagnostics to stderr.
      // The command's own output must still be preserved in that log.
      expect(await readFile(result.detached!.stderrPath, 'utf8')).toContain('stderr 中文')
    } finally {
      await writeFile(proceed, '')
      await service.shutdown()
      await h.close()
      await cleanup(root, result)
    }
  }, 15_000)

  it('does not claim independent launch when the executable cannot start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-independent-failure-'))
    try {
      const input = prepared('missing executable', root)
      input.invocation.executable = join(root, 'does-not-exist')
      const result = JSON.parse(await runPreparedProcess(input)) as ShellRunResult
      expect(result.ok).toBe(false)
      expect(result.error).toContain('ENOENT')
      expect(result.detached).toBeUndefined()
    } finally { await cleanup(root) }
  }, 10_000)

  it('preserves descendants when the independent launcher exits with a failure code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-independent-descendant-'))
    const proceed = join(root, 'continue')
    const completed = join(root, 'completed')
    let result: ShellRunResult | undefined
    try {
      const child = `const fs = require('node:fs');
        const deadline = setTimeout(() => process.exit(2), 12000);
        const poll = setInterval(() => {
          if (!fs.existsSync(${JSON.stringify(proceed)})) return;
          clearInterval(poll); clearTimeout(deadline);
          fs.writeFileSync(${JSON.stringify(completed)}, 'survived');
        }, 20);`
      result = JSON.parse(await runPreparedProcess(prepared(`
        require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}],
          { detached: true, stdio: 'ignore', env: process.env }).unref();
        process.stderr.write('launcher exit 1'); process.exitCode = 1;
      `, root))) as ShellRunResult
      expect(result).toMatchObject({ ok: true, detached: { pid: expect.any(Number) } })
      expect(result.exitCode).toBeUndefined()
      await vi.waitFor(async () => expect(await readFile(result!.detached!.stderrPath, 'utf8'))
        .toContain('launcher exit 1'), { timeout: 5_000 })
      await writeFile(proceed, '')
      await vi.waitFor(async () => expect(await readFile(completed, 'utf8')).toBe('survived'), { timeout: 5_000 })
    } finally {
      await writeFile(proceed, '')
      await cleanup(root, result)
    }
  }, 15_000)

  it.runIf(process.platform === 'win32')('cancels an already spawned process before ownership handoff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-independent-handoff-cancel-'))
    const controller = new AbortController()
    const send = DetachedWindowsShellSupervisor.prototype.send
    let childPid: number | undefined
    const emit = DetachedWindowsShellSupervisor.prototype.emit
    const spyEmit = vi.spyOn(DetachedWindowsShellSupervisor.prototype, 'emit').mockImplementation(function (this: DetachedWindowsShellSupervisor, event, ...args) {
      if (event === 'message' && args[0]?.type === 'started') childPid = args[0].pid
      return emit.call(this, event, ...args)
    })
    const spySend = vi.spyOn(DetachedWindowsShellSupervisor.prototype, 'send').mockImplementation(function (this: DetachedWindowsShellSupervisor, message, callback) {
      if ((message as { type?: string })?.type === 'prepare_release') controller.abort()
      return send.call(this, message, callback)
    })
    try {
      const result = JSON.parse(await runPreparedProcess(prepared('setTimeout(() => {}, 12000)', root), controller.signal)) as ShellRunResult
      expect(childPid).toBeGreaterThan(0)
      expect(result).toMatchObject({ ok: false, aborted: true })
      expect(result.detached).toBeUndefined()
      await vi.waitFor(() => expect(() => process.kill(childPid!, 0)).toThrow(), { timeout: 5_000 })
    } finally {
      spyEmit.mockRestore()
      spySend.mockRestore()
      await cleanup(root)
    }
  }, 10_000)

  it.runIf(process.platform !== 'win32').each(['prepare_release', 'release_ready'])(
    'reaps the POSIX process group when cancelled at %s before ownership handoff', async (boundary) => {
      const root = await mkdtemp(join(tmpdir(), 'anas-independent-posix-cancel-'))
      const controller = new AbortController()
      const emit = ChildProcess.prototype.emit
      let supervisorPid: number | undefined
      let childPid: number | undefined
      let outputDirectory: string | undefined
      let restoreSend: (() => void) | undefined
      let intercepted = false
      let reaped = false
      const spy = vi.spyOn(ChildProcess.prototype, 'emit').mockImplementation(function (this: ChildProcess, event, ...args) {
        if (event === 'message' && args[0]?.type === 'ready' && args[0].pid === this.pid) {
          supervisorPid = this.pid
          const send = this.send.bind(this)
          const sendSpy = vi.spyOn(this, 'send').mockImplementation((...parameters) => {
            if ((parameters[0] as { type?: string })?.type === 'prepare_release' && boundary === 'prepare_release') {
              intercepted = true
              controller.abort()
            }
            return Reflect.apply(send, this, parameters)
          })
          restoreSend = () => sendSpy.mockRestore()
        }
        if (event === 'message' && args[0]?.type === 'started' && this.pid === supervisorPid) {
          childPid = args[0].pid
          if (args[0].outputFiles) outputDirectory = dirname(args[0].outputFiles.stdoutPath)
        }
        if (event === 'message' && args[0]?.type === 'release_ready' && this.pid === supervisorPid && boundary === 'release_ready') {
          intercepted = true
          controller.abort()
        }
        return emit.call(this, event, ...args)
      })
      try {
        const result = JSON.parse(await runPreparedProcess(prepared('setTimeout(() => {}, 12000)', root), controller.signal)) as ShellRunResult
        expect(intercepted).toBe(true)
        expect(childPid).toBeGreaterThan(0)
        expect(supervisorPid).toBeGreaterThan(0)
        expect(result).toMatchObject({ ok: false, aborted: true })
        expect(result.detached).toBeUndefined()
        await vi.waitFor(() => {
          expect(() => process.kill(childPid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
          const groups = execFileSync('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' })
            .trim().split('\n').map(line => Number(line.trim().split(/\s+/)[1]))
          expect(groups).not.toContain(supervisorPid)
        }, { timeout: 5_000 })
        reaped = true
      } finally {
        restoreSend?.()
        spy.mockRestore()
        if (supervisorPid && !reaped) {
          try { process.kill(-supervisorPid, 'SIGKILL') } catch { /* Preserve the failed containment assertion. */ }
        }
        await cleanup(root)
        if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true })
      }
    }, 10_000)

  it('honors cancellation before dispatch without executing the command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-independent-cancel-'))
    const marker = join(root, 'must-not-run')
    const controller = new AbortController()
    try {
      const result = JSON.parse(await runPreparedProcess(
        prepared(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`, root), controller.signal,
        { onDispatched: () => controller.abort() }
      )) as ShellRunResult
      expect(result).toMatchObject({ ok: false, aborted: true })
      expect(result.detached).toBeUndefined()
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await cleanup(root) }
  }, 10_000)

  it('rejects a managed timeout instead of silently discarding it', () => {
    expect(() => runPreparedProcess({ ...prepared('unused', process.cwd()), timeoutSec: 5 }))
      .toThrow('Independent processes cannot have a managed execution timeout')
  })

  it.runIf(process.platform === 'win32').each(['powershell.exe', 'pwsh.exe'])('launches a direct %s command and records output after cancellation', async (executable) => {
    const root = await mkdtemp(join(tmpdir(), 'anas-independent-pwsh-'))
    const proceed = join(root, 'continue')
    const controller = new AbortController()
    let result: ShellRunResult | undefined
    try {
      result = JSON.parse(await runShellCommand({
        command: `$deadline = [DateTime]::UtcNow.AddSeconds(10)\nwhile (-not (Test-Path -LiteralPath '${proceed.replaceAll("'", "''")}') -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 20 }\n[Console]::Out.Write('独立运行')\n[Console]::Error.Write('错误输出')`,
        workingDir: root, timeoutSec: 0, keepProcesses: true
      }, { executable, name: 'PowerShell', family: 'powershell' }, controller.signal)) as ShellRunResult
      expect(result).toMatchObject({ ok: true, detached: { pid: expect.any(Number) } })
      controller.abort()
      await writeFile(proceed, '')
      await vi.waitFor(async () => {
        expect({ stdout: await readFile(result!.detached!.stdoutPath, 'utf8'),
          stderr: await readFile(result!.detached!.stderrPath, 'utf8') })
          .toEqual({ stdout: '独立运行', stderr: '错误输出' })
      }, { timeout: 5_000 })
    } finally {
      await writeFile(proceed, '')
      await cleanup(root, result)
    }
  }, 15_000)
})
