import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import manifest from '../../build/python-runtime.json'
import { getCommandShell, runShellCommand, type ShellRunResult } from './shellRuntime'
import { getBundledPythonInfo } from './bundledPython'
import { customToolDefinitions } from './agent/customToolRuntime'
import { withToolExecution } from './agent/toolExecutionContext'
import type { ManagedCallControl } from './agent/managedCallService'
import { parseCustomTools } from '@shared/customTools'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => state.root } }))
vi.mock('./config/dataDir', async original => ({ ...await original<typeof import('./config/dataDir')>(), getDataDir: () => join(state.root, 'data') }))
vi.mock('./runtimeLogger', () => ({ runtimeLog: vi.fn() }))
const roots: string[] = []
const payload = resolve('build/python-runtime', `${process.platform}-${process.arch}`, 'python')
const entry = process.platform === 'win32' ? 'python.exe' : 'bin/python3'
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture() {
  state.root = await mkdtemp(join(tmpdir(), "anas python fallback 中文 '"))
  roots.push(state.root)
  const destination = join(state.root, 'data/runtimes/python', manifest.version)
  await mkdir(dirname(destination), { recursive: true })
  await symlink(payload, destination, process.platform === 'win32' ? 'junction' : 'dir')
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONHOME: undefined, PYTHONPATH: undefined,
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PATH: '' }
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path' && key !== 'PATH') delete env[key]
  return { root: state.root, env, executable: join(destination, entry) }
}

async function customTool(h: Awaited<ReturnType<typeof fixture>>, interactive: boolean, bundledPython: boolean) {
  const [definition] = parseCustomTools([{ version: 0, id: 'python-fallback', name: 'python_fallback', description: 'Fixture',
    command: 'script.py {{args}}', input_schema: { type: 'object', properties: {} }, timeout_seconds: 10, interactive }])
  const [tool] = customToolDefinitions([{ ...definition, directory: h.root }], { env: h.env, backgroundTools: true, bundledPython })
  const control = { signal: new AbortController().signal, markRunning: vi.fn(), markUncertain: vi.fn(),
    output: vi.fn(), setTerminal: vi.fn(), setOutcome: vi.fn() } as unknown as ManagedCallControl
  const result = await withToolExecution(control, false, () => tool.execute({}, { callId: 'fallback' }))
  return String(result.content)
}

// Run with the real payload after prepare:python on the corresponding platform.
describe.skipIf(!['win32', 'darwin'].includes(process.platform) || !existsSync(join(payload, entry)))('bundled Python as an explicit fallback', () => {
  it.each([false, true].flatMap(interactive => [false, true].map(enabled => ({ interactive, enabled }))))('falls back only when enabled ($enabled), including PTY ($interactive)', async ({ interactive, enabled }) => {
    const h = await fixture()
    await writeFile(join(h.root, 'script.py'), `import sys\nprint('BUNDLED_OK' if sys.executable == ${JSON.stringify(h.executable)} else 'WRONG_INTERPRETER')\n`)
    const output = await customTool(h, interactive, enabled)
    if (enabled) expect(output).toContain('BUNDLED_OK')
    else expect(JSON.parse(output)).toMatchObject({ ok: false, error: expect.stringContaining('No usable Python 3') })
    expect(h.env.PATH).toBe('')
  }, 20000)

  it.each([false, true])('prefers an installed system interpreter, even under WindowsApps (PTY=%s)', async interactive => {
    const h = await fixture(), system = join(h.root, 'WindowsApps')
    await symlink(payload, system, process.platform === 'win32' ? 'junction' : 'dir')
    const executable = join(system, entry)
    h.env.PATH = dirname(executable)
    await writeFile(join(h.root, 'script.py'), `import sys\nprint('SYSTEM_OK' if sys.executable == ${JSON.stringify(executable)} else 'WRONG_INTERPRETER')\n`)
    expect(await customTool(h, interactive, true)).toContain('SYSTEM_OK')
  }, 20000)

  it('does not cache a bundled fallback as the system choice when a system interpreter becomes available', async () => {
    const h = await fixture(), system = join(h.root, 'later-system')
    const executable = join(system, entry)
    h.env.PATH = dirname(executable)
    await writeFile(join(h.root, 'script.py'), `import sys\nprint('SYSTEM_OK' if sys.executable == ${JSON.stringify(executable)} else 'BUNDLED_OK')\n`)
    expect(await customTool(h, false, true)).toContain('BUNDLED_OK')
    await symlink(payload, system, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await customTool(h, false, true)).toContain('SYSTEM_OK')
  }, 20000)

  it.skipIf(process.platform !== 'win32')('rejects an existing Store-style alias that prints an install hint and exits unsuccessfully', async () => {
    const h = await fixture(), aliases = join(h.root, 'WindowsApps')
    await mkdir(aliases)
    await copyFile(process.env.npm_node_execpath!, join(aliases, 'python.exe'))
    await writeFile(join(h.root, 'store-alias.cjs'), 'console.error("Python was not found; run without arguments to install from the Microsoft Store."); process.exit(9009)')
    h.env.PATH = aliases
    h.env.NODE_OPTIONS = '--require ./store-alias.cjs'
    await writeFile(join(h.root, 'script.py'), `import sys\nprint('BUNDLED_OK' if sys.executable == ${JSON.stringify(h.executable)} else 'WRONG_INTERPRETER')\n`)
    expect(await customTool(h, false, true)).toContain('BUNDLED_OK')
    expect(JSON.parse(await customTool(h, false, false))).toMatchObject({ ok: false, error: expect.stringContaining('No usable Python 3') })
  }, 20000)

  it.each([false, true])('lets Shell use the supplied absolute path without adding Python to PATH (PTY=%s)', async interactive => {
    const h = await fixture()
    const shell = { ...await getCommandShell() }
    if (process.platform === 'win32') shell.executable = (await promisify(execFile)(shell.executable,
      ['-NoProfile', '-Command', '(Get-Process -Id $PID).Path'], { windowsHide: true })).stdout.trim()
    const info = getBundledPythonInfo()!
    expect(info).toMatchObject({ executable: h.executable, state: 'installed' })
    const quote = (text: string) => `'${text.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`
    const command = `${process.platform === 'win32' ? '& ' : ''}${quote(info.executable)} -c ${quote('print("EXPLICIT_OK")')}`
    let result: ShellRunResult | undefined
    await runShellCommand({ command, env: h.env, workingDir: h.root, timeoutSec: 10, keepProcesses: false,
      ...(interactive ? { pty: { columns: 100, rows: 24 } } : {}) }, shell, undefined, { onResult: value => { result = value } })
    expect(result?.ok).toBe(true)
    expect(result?.stdout).toContain('EXPLICIT_OK')
    expect(result?.command).toBe(command)
    expect(h.env.PATH).toBe('')
  }, 20000)
})
