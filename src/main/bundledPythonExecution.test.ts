import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCommandShell, runShellCommand, type ShellRunResult } from './shellRuntime'
import { bundledPythonArgs, getBundledPythonInfo } from './bundledPython'
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
  const destination = join(state.root, 'build/python-runtime', `${process.platform}-${process.arch}`, 'python')
  await mkdir(dirname(destination), { recursive: true })
  await symlink(payload, destination, process.platform === 'win32' ? 'junction' : 'dir')
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONHOME: undefined, PYTHONPATH: undefined,
    PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PATH: '' }
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path' && key !== 'PATH') delete env[key]
  return { root: state.root, env, executable: join(destination, entry) }
}

async function customTool(h: Awaited<ReturnType<typeof fixture>>, interactive: boolean) {
  const [definition] = parseCustomTools([{ version: 0, id: 'python-fallback', name: 'python_fallback', description: 'Fixture',
    command: 'script.py {{args}}', input_schema: { type: 'object', properties: {} }, timeout_seconds: 10, interactive }])
  const [tool] = customToolDefinitions([{ ...definition, directory: h.root }], { env: h.env, backgroundTools: true })
  const control = { signal: new AbortController().signal, markRunning: vi.fn(), markUncertain: vi.fn(),
    output: vi.fn(), setTerminal: vi.fn(), setOutcome: vi.fn() } as unknown as ManagedCallControl
  const result = await withToolExecution(control, false, () => tool.execute({}, { callId: 'fallback' }))
  return String(result.content)
}

// Run with the real payload after prepare:python on the corresponding platform.
describe.skipIf(!['win32', 'darwin'].includes(process.platform) || !existsSync(join(payload, entry)))('bundled Python as an explicit fallback', () => {
  it.each([false, true])('falls back to the bundled interpreter when system Python is missing (PTY=%s)', async interactive => {
    const h = await fixture()
    await writeFile(join(h.root, 'script.py'), `import sys\nprint('BUNDLED_OK' if sys.executable == ${JSON.stringify(h.executable)} else 'WRONG_INTERPRETER')\n`)
    expect(await customTool(h, interactive)).toContain('BUNDLED_OK')
    expect(h.env.PATH).toBe('')
  }, 20000)

  it.each([false, true])('isolates bundled packages while preserving local imports and output writes (PTY=%s)', async interactive => {
    const h = await fixture()
    const injected = join(h.root, 'injected')
    await mkdir(injected)
    await writeFile(join(injected, 'sitecustomize.py'), 'raise RuntimeError("user injection")')
    await writeFile(join(injected, 'anas_injected.py'), 'value = "must not load"')
    await writeFile(join(h.root, 'local_helper.py'), 'value = "中文🙂"')
    h.env.PYTHONPATH = injected
    h.env.PYTHONHOME = join(h.root, 'invalid-python-home')
    h.env.PYTHONUSERBASE = injected
    h.env.PYTHONDONTWRITEBYTECODE = undefined
    h.env.PYTHONNOUSERSITE = undefined
    h.env.ANAS_CUSTOM_VALUE = 'business environment'
    await writeFile(join(h.root, 'script.py'), [
      'import os, sys, site, sysconfig, importlib.util, pathlib, local_helper',
      'assert sys.flags.ignore_environment and sys.flags.no_user_site and sys.dont_write_bytecode',
      'assert not site.ENABLE_USER_SITE',
      'assert all(importlib.util.find_spec(name) is None for name in ("pip", "ensurepip", "setuptools", "wheel", "anas_injected"))',
      'assert (pathlib.Path(sysconfig.get_path("stdlib")) / "EXTERNALLY-MANAGED").is_file()',
      'assert os.environ["ANAS_CUSTOM_VALUE"] == "business environment"',
      'pathlib.Path("output.txt").write_text(local_helper.value, encoding="utf-8")',
      'print(local_helper.value)'
    ].join('\n'))
    expect(await customTool(h, interactive)).toContain('中文🙂')
    expect(await readFile(join(h.root, 'output.txt'), 'utf8')).toBe('中文🙂')
    expect(existsSync(join(h.root, '__pycache__'))).toBe(false)
    expect(existsSync(join(h.root, 'data/runtimes'))).toBe(false)
  }, 20000)

  it.each([false, true])('prefers an installed system interpreter, even under WindowsApps (PTY=%s)', async interactive => {
    const h = await fixture(), system = join(h.root, 'WindowsApps')
    await symlink(payload, system, process.platform === 'win32' ? 'junction' : 'dir')
    const executable = join(system, entry)
    h.env.PATH = dirname(executable)
    await writeFile(join(h.root, 'script.py'), `import sys\nprint('SYSTEM_OK' if sys.executable == ${JSON.stringify(executable)} else 'WRONG_INTERPRETER')\n`)
    expect(await customTool(h, interactive)).toContain('SYSTEM_OK')
  }, 20000)

  it('does not cache a bundled fallback as the system choice when a system interpreter becomes available', async () => {
    const h = await fixture(), system = join(h.root, 'later-system')
    const executable = join(system, entry)
    h.env.PATH = dirname(executable)
    await writeFile(join(h.root, 'script.py'), `import sys\nprint('SYSTEM_OK' if sys.executable == ${JSON.stringify(executable)} else 'BUNDLED_OK')\n`)
    expect(await customTool(h, false)).toContain('BUNDLED_OK')
    await symlink(payload, system, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await customTool(h, false)).toContain('SYSTEM_OK')
  }, 20000)

  it.skipIf(process.platform !== 'win32')('rejects an existing Store-style alias that prints an install hint and exits unsuccessfully', async () => {
    const h = await fixture(), aliases = join(h.root, 'WindowsApps')
    await mkdir(aliases)
    await copyFile(process.env.npm_node_execpath!, join(aliases, 'python.exe'))
    await writeFile(join(h.root, 'store-alias.cjs'), 'console.error("Python was not found; run without arguments to install from the Microsoft Store."); process.exit(9009)')
    h.env.PATH = aliases
    h.env.NODE_OPTIONS = '--require ./store-alias.cjs'
    await writeFile(join(h.root, 'script.py'), `import sys\nprint('BUNDLED_OK' if sys.executable == ${JSON.stringify(h.executable)} else 'WRONG_INTERPRETER')\n`)
    expect(await customTool(h, false)).toContain('BUNDLED_OK')
  }, 20000)

  it.each([false, true])('lets Shell use the supplied absolute path without adding Python to PATH (PTY=%s)', async interactive => {
    const h = await fixture()
    const shell = { ...await getCommandShell() }
    if (process.platform === 'win32') shell.executable = (await promisify(execFile)(shell.executable,
      ['-NoProfile', '-Command', '(Get-Process -Id $PID).Path'], { windowsHide: true })).stdout.trim()
    const info = getBundledPythonInfo()!
    expect(info).toMatchObject({ executable: h.executable, state: 'available' })
    const quote = (text: string) => `'${text.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`
    const command = `${process.platform === 'win32' ? '& ' : ''}${quote(info.executable)} ${bundledPythonArgs.join(' ')} -c ${quote('print("EXPLICIT_OK")')}`
    let result: ShellRunResult | undefined
    await runShellCommand({ command, env: h.env, workingDir: h.root, timeoutSec: 10,
      ...(interactive ? { pty: { columns: 100, rows: 24 } } : {}) }, shell, undefined, { onResult: value => { result = value } })
    expect(result?.ok).toBe(true)
    expect(result?.stdout).toContain('EXPLICIT_OK')
    expect(result?.command).toBe(command)
    expect(h.env.PATH).toBe('')
  }, 20000)
})
