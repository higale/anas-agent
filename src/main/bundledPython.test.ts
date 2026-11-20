import { access, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBundledPythonInfo, ensureBundledPython } from './bundledPython'
import manifest from '../../build/python-runtime.json'

const state = vi.hoisted(() => ({ root: '', failCopy: false, failPublish: false, failRollback: false, copyGate: undefined as Promise<void> | undefined }))
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => state.root } }))
vi.mock('./config/dataDir', () => ({ getDataDir: () => join(state.root, 'data') }))
vi.mock('./runtimeLogger', () => ({ runtimeLog: vi.fn() }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, cp: vi.fn(async (...args: Parameters<typeof fs.cp>) => {
    await state.copyGate
    await fs.cp(...args)
    if (state.failCopy) throw new Error('simulated copy failure')
  }), rename: vi.fn(async (...args: Parameters<typeof fs.rename>) => {
    if (state.failPublish && String(args[0]).includes('python-release-')) throw new Error('simulated publish failure')
    if (state.failRollback && String(args[0]).includes('.reset-')) throw new Error('simulated rollback failure')
    return fs.rename(...args)
  }) }
})
let source: string
beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), "anas py 中文 '"))
  source = join(state.root, 'build/python-runtime', process.platform + '-' + process.arch, 'python')
  state.failCopy = false
  state.failPublish = false
  state.failRollback = false
  state.copyGate = undefined
})
afterEach(async () => { await rm(state.root, { recursive: true, force: true }); state.root = '' })
async function payload() {
  const executable = join(source, process.platform === 'win32' ? 'python.exe' : 'bin/python3')
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(executable, 'runtime', { mode: 0o755 })
  return executable
}
function installedExecutable() {
  return join(state.root, 'data/runtimes/python', manifest.version, process.platform === 'win32' ? 'python.exe' : 'bin/python3')
}

describe.skipIf(!['win32', 'darwin'].includes(process.platform))('writable bundled Python', () => {
  it('describes the target before preparation without extracting or probing during lookup', async () => {
    expect(getBundledPythonInfo()).toBeUndefined()
    await payload()
    expect(getBundledPythonInfo()?.executable).toBe(installedExecutable())
    expect(getBundledPythonInfo()?.state).toBe('preparing')
    expect(cp).not.toHaveBeenCalled()
    await ensureBundledPython()
    expect(getBundledPythonInfo()?.executable).toBe(installedExecutable())
    expect(getBundledPythonInfo()?.state).toBe('installed')
    await expect(access(installedExecutable())).resolves.toBeUndefined()
  })

  it('shares concurrent extraction and preserves installed packages on subsequent runs', async () => {
    const sourceExecutable = await payload()
    const [first, second] = await Promise.all([ensureBundledPython(), ensureBundledPython()])
    expect(first).toEqual(second)
    expect(cp).toHaveBeenCalledTimes(1)
    expect(await readFile(first!.executable, 'utf8')).toBe('runtime')
    const installed = join(dirname(first!.executable), 'user-installed.txt')
    await writeFile(installed, 'keep packages')
    await writeFile(sourceExecutable, 'new application contents')
    await ensureBundledPython()
    expect(await readFile(installed, 'utf8')).toBe('keep packages')
    expect(await readFile(first!.executable, 'utf8')).toBe('runtime')
    expect(cp).toHaveBeenCalledTimes(1)
  })

  it('publishes only complete copies and retries a failed extraction', async () => {
    await payload()
    const executable = installedExecutable()
    state.failCopy = true
    await expect(ensureBundledPython()).rejects.toThrow('simulated copy failure')
    await expect(access(executable)).rejects.toThrow()
    expect(await readdir(join(state.root, 'data/tmp'))).toEqual([])
    state.failCopy = false
    await ensureBundledPython()
    expect(await readFile(executable, 'utf8')).toBe('runtime')
  })

  it('does not overwrite a damaged existing environment or install on cancelled requests', async () => {
    await payload()
    const controller = new AbortController()
    controller.abort()
    await expect(ensureBundledPython(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    const executable = installedExecutable()
    await mkdir(dirname(executable), { recursive: true })
    await writeFile(join(dirname(executable), 'keep.txt'), 'user data')
    await expect(ensureBundledPython()).rejects.toThrow('incomplete')
    expect(await readFile(join(dirname(executable), 'keep.txt'), 'utf8')).toBe('user data')
    expect(cp).not.toHaveBeenCalled()
  })

  it('reports preparation independently while consumers remain available and shares startup work', async () => {
    vi.resetModules()
    const startup = await import('./bundledPython')
    await payload()
    let release!: () => void
    state.copyGate = new Promise<void>(resolve => { release = resolve })
    expect(startup.getPythonRuntimeStatus()).toEqual({ state: 'idle' })
    const preparation = startup.initializeBundledPython()
    try {
      expect(startup.getPythonRuntimeStatus()).toEqual({ state: 'preparing' })
      expect(startup.getBundledPythonInfo()?.executable).toBe(installedExecutable())
      expect(startup.initializeBundledPython()).toBe(preparation)
      await expect(startup.resetBundledPython()).rejects.toThrow('still being prepared')
    } finally {
      release()
      await preparation
    }
    expect(startup.getPythonRuntimeStatus()).toEqual({ state: 'ready' })
    expect(startup.getBundledPythonInfo()?.executable).toBe(installedExecutable())
    expect(cp).toHaveBeenCalledTimes(1)
  })

  it('contains startup copy failures without publishing a runtime or retrying in conversation consumers', async () => {
    vi.resetModules()
    const startup = await import('./bundledPython')
    await payload()
    state.failCopy = true
    await expect(startup.initializeBundledPython()).resolves.toBeUndefined()
    expect(startup.getPythonRuntimeStatus()).toEqual({ state: 'error', error: 'simulated copy failure' })
    expect(startup.getBundledPythonInfo()?.executable).toBe(installedExecutable())
    await expect(access(installedExecutable())).rejects.toThrow()
    expect(startup.getBundledPythonInfo()?.state).toBe('unavailable')
    expect(await readdir(join(state.root, 'data/tmp'))).toEqual([])
    expect(cp).toHaveBeenCalledTimes(1)
  })

  it('allows startup without a bundled payload', async () => {
    vi.resetModules()
    const startup = await import('./bundledPython')
    await expect(startup.initializeBundledPython()).resolves.toBeUndefined()
    expect(startup.getPythonRuntimeStatus()).toEqual({ state: 'unavailable' })
    expect(cp).not.toHaveBeenCalled()
  })

  it('restores a damaged environment on explicit reset, keeping other versions and external environments', async () => {
    vi.resetModules()
    const startup = await import('./bundledPython')
    await payload()
    const root = join(state.root, 'data/runtimes/python', manifest.version)
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'installed-package.txt'), 'modified environment')
    const other = join(state.root, 'data/runtimes/python/other-version')
    const external = join(state.root, 'project/.venv')
    for (const directory of [other, external]) {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'keep.txt'), 'keep')
    }
    await startup.initializeBundledPython()
    expect(startup.getPythonRuntimeStatus().state).toBe('error')
    await startup.resetBundledPython()
    expect(startup.getPythonRuntimeStatus()).toEqual({ state: 'ready' })
    expect(await readFile(installedExecutable(), 'utf8')).toBe('runtime')
    expect(await readdir(root)).not.toContain('installed-package.txt')
    expect((await readdir(dirname(root))).sort()).toEqual([manifest.version, 'other-version'].sort())
    for (const directory of [other, external]) expect(await readFile(join(directory, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it.each(['copy', 'publish'])('preserves the previous environment when reset fails at %s', async failure => {
    vi.resetModules()
    const startup = await import('./bundledPython')
    await payload()
    await startup.initializeBundledPython()
    await writeFile(installedExecutable(), 'user-modified runtime')
    state.failCopy = failure === 'copy'
    state.failPublish = failure === 'publish'
    await expect(startup.resetBundledPython()).rejects.toThrow(`simulated ${failure} failure`)
    expect(await readFile(installedExecutable(), 'utf8')).toBe('user-modified runtime')
    expect(startup.getBundledPythonInfo()?.executable).toBe(installedExecutable())
    expect(await readdir(join(state.root, 'data/tmp'))).toEqual([])
    expect(await readdir(join(state.root, 'data/runtimes/python'))).toEqual([manifest.version])
    state.failCopy = state.failPublish = false
    await startup.resetBundledPython()
    expect(await readFile(installedExecutable(), 'utf8')).toBe('runtime')
  })

  it('prepares Python again at the next startup after the entire version directory is deleted', async () => {
    await payload()
    await ensureBundledPython()
    await rm(join(state.root, 'data/runtimes/python', manifest.version), { recursive: true })
    vi.resetModules()
    const startup = await import('./bundledPython')
    await startup.initializeBundledPython()
    expect(startup.getPythonRuntimeStatus()).toEqual({ state: 'ready' })
    expect(await readFile(installedExecutable(), 'utf8')).toBe('runtime')
  })

  it('keeps the previous environment outside temporary cleanup if rollback also fails', async () => {
    vi.resetModules()
    const startup = await import('./bundledPython')
    await payload()
    await startup.initializeBundledPython()
    await writeFile(installedExecutable(), 'user-modified runtime')
    state.failPublish = state.failRollback = true
    await expect(startup.resetBundledPython()).rejects.toThrow('previous environment is preserved at')
    const versions = join(state.root, 'data/runtimes/python')
    const preserved = (await readdir(versions)).find(name => name.startsWith(manifest.version + '.reset-'))!
    expect(preserved).toBeTruthy()
    expect(await readFile(join(versions, preserved, process.platform === 'win32' ? 'python.exe' : 'bin/python3'), 'utf8')).toBe('user-modified runtime')
    expect(await readdir(join(state.root, 'data/tmp'))).toEqual([])
  })

  it('rejects reset during an application-data transition without modifying the environment', async () => {
    vi.resetModules()
    const startup = await import('./bundledPython')
    const lifecycle = await import('./applicationDataLifecycle')
    await payload()
    await startup.initializeBundledPython()
    await writeFile(installedExecutable(), 'keep')
    await lifecycle.beginApplicationDataTransition()
    try {
      await expect(startup.resetBundledPython()).rejects.toThrow('being restored')
      expect(await readFile(installedExecutable(), 'utf8')).toBe('keep')
    } finally { lifecycle.finishApplicationDataTransition() }
  })
})
