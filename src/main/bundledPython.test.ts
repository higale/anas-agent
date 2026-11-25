import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { discoverBundledPython, getBundledPythonInfo } from './bundledPython'
import { probePython3 } from './runtimeDiscovery'
import manifest from '../../build/python-runtime.json'

const state = vi.hoisted(() => ({ root: '', packaged: false }))
vi.mock('electron', () => ({ app: { get isPackaged() { return state.packaged }, getAppPath: () => state.root } }))
vi.mock('./runtimeDiscovery', () => ({ probePython3: vi.fn() }))
beforeEach(async () => { state.root = await mkdtemp(join(tmpdir(), "anas py 中文 '")); state.packaged = false })
afterEach(async () => { vi.unstubAllGlobals(); await rm(state.root, { recursive: true, force: true }) })
const entry = process.platform === 'win32' ? 'python.exe' : 'bin/python3'
async function payload(root: string) {
  const executable = join(root, entry)
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(executable, 'runtime', { mode: 0o755 })
  return executable
}

describe.skipIf(!((process.platform + '-' + process.arch) in manifest.targets))('application-owned bundled Python', () => {
  it('uses development resources directly without creating a user runtime', async () => {
    const executable = await payload(join(state.root, 'build/python-runtime', process.platform + '-' + process.arch, 'python'))
    expect(getBundledPythonInfo()).toEqual({ executable, version: manifest.version, state: 'available' })
    expect(await readdir(state.root)).toEqual(['build'])
    expect(probePython3).not.toHaveBeenCalled()
  })

  it('uses packaged resources independently of the app archive', async () => {
    state.packaged = true
    const resourcesPath = join(state.root, 'resources')
    vi.stubGlobal('process', { ...process, resourcesPath })
    const executable = await payload(join(resourcesPath, 'python'))
    const libraries = join(resourcesPath, 'python', 'anas-documents')
    await mkdir(join(libraries, 'python_pptx-1.0.2.dist-info'), { recursive: true })
    await mkdir(join(libraries, 'markitdown-0.1.9.dist-info'))
    expect(getBundledPythonInfo()?.documentPackages).toEqual(['markitdown 0.1.9 (selected anas_markitdown converters only)', 'python_pptx 1.0.2 (import pptx)'])
    expect(getBundledPythonInfo()?.executable).toBe(executable)
    vi.mocked(probePython3).mockResolvedValue({ executable, version: manifest.version, command: executable })
    expect((await discoverBundledPython())?.executable).toBe(executable)
  })

  it('leaves a previous user runtime intact without falling back to it when package files are missing', async () => {
    const old = await payload(join(state.root, 'data/runtimes/python', manifest.version))
    expect(getBundledPythonInfo()?.state).toBe('unavailable')
    expect(await discoverBundledPython()).toBeUndefined()
    expect(probePython3).not.toHaveBeenCalled()
    expect(await readFile(old, 'utf8')).toBe('runtime')
    expect(await readdir(state.root)).toEqual(['data'])
  })

  it('stops cancelled discovery before probing', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(discoverBundledPython({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(probePython3).not.toHaveBeenCalled()
  })
})
