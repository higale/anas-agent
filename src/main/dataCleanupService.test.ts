import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withApplicationDataSnapshot } from './applicationDataSnapshot'

const paths = vi.hoisted(() => ({
  cache: '',
  developerHttpTrace: '',
  log: '',
  temp: ''
}))

vi.mock('./config/dataDir', () => ({
  getDataDir: () => root,
  getCacheDir: () => paths.cache,
  getDeveloperHttpTraceDir: () => paths.developerHttpTrace,
  getLogDir: () => paths.log,
  getTempDir: () => paths.temp
}))

vi.mock('./inputHistoryStore', () => ({
  clearInputHistory: vi.fn(async () => undefined)
}))

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'anas-data-cleanup-'))
  paths.cache = join(root, 'cache')
  paths.developerHttpTrace = join(root, 'dev', 'model-http')
  paths.log = join(root, 'log')
  paths.temp = join(root, 'tmp')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('data cleanup service', () => {
  it('refuses developer trace cleanup through a linked parent', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'anas-trace-external-'))
    try {
      await mkdir(join(outside, 'model-http'))
      const sentinel = join(outside, 'model-http', 'keep.txt')
      await writeFile(sentinel, 'must survive')
      await symlink(outside, join(root, 'dev'), process.platform === 'win32' ? 'junction' : 'dir')
      const { cleanupData } = await import('./dataCleanupService')
      const result = await cleanupData({ developer_http_trace: true })
      expect(result.items[0].ok).toBe(false)
      expect(await readFile(sentinel, 'utf8')).toBe('must survive')
    } finally { await rm(outside, { recursive: true, force: true }) }
  })

  it('initializes a missing log directory and preserves it after clearing regular contents', async () => {
    const { cleanupData } = await import('./dataCleanupService')
    expect((await cleanupData({ log_folder: true })).items[0].ok).toBe(true)
    await mkdir(join(paths.log, 'nested'))
    await writeFile(join(paths.log, 'nested', 'old.log'), 'old')
    expect((await cleanupData({ log_folder: true })).items[0].ok).toBe(true)
    expect((await lstat(paths.log)).isDirectory()).toBe(true)
    expect(await readdir(paths.log)).toEqual([])
  })

  it.each([true, false])('does not follow external log links (linked root=%s)', async linkedRoot => {
    const outside = await mkdtemp(join(tmpdir(), 'anas-cleanup-external-'))
    try {
      const sentinel = join(outside, 'keep.txt')
      await writeFile(sentinel, 'must survive')
      if (!linkedRoot) await mkdir(paths.log)
      const link = linkedRoot ? paths.log : join(paths.log, 'linked-child')
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
      const { cleanupData } = await import('./dataCleanupService')
      const result = await cleanupData({ log_folder: true })
      expect(await readFile(sentinel, 'utf8')).toBe('must survive')
      expect(result.items[0].ok).toBe(!linkedRoot)
      if (linkedRoot) expect((await lstat(link)).isSymbolicLink()).toBe(true)
      else expect(await readdir(paths.log)).toEqual([])
    } finally { await rm(outside, { recursive: true, force: true }) }
  })

  it('waits for an in-progress backup before deleting its unknown source files', async () => {
    await writeFile(join(root, 'old.zip'), 'backup')
    const { cleanupData } = await import('./dataCleanupService')
    let finishBackup!: () => void
    let enterBackup!: () => void
    const entered = new Promise<void>(resolve => { enterBackup = resolve })
    const pending = new Promise<void>(resolve => { finishBackup = resolve })
    const backup = withApplicationDataSnapshot(async () => { enterBackup(); await pending })
    await entered
    const cleanup = cleanupData({ unknown_files: true, unknown_file_paths: ['old.zip'] })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(await readdir(root)).toContain('old.zip')
    } finally {
      finishBackup()
      await Promise.all([backup, cleanup])
    }
    expect(await readdir(root)).not.toContain('old.zip')
  })

  it('only removes unknown files when explicitly selected, using the supplied preview', async () => {
    await writeFile(join(root, 'old.zip'), 'backup')
    const { cleanupData } = await import('./dataCleanupService')
    await cleanupData({ unknown_files: false, unknown_file_paths: ['old.zip'] })
    expect(await readdir(root)).toContain('old.zip')
    await expect(cleanupData({ unknown_files: true, unknown_file_paths: ['old.zip'] })).resolves.toEqual({
      items: [{ target: 'unknown_files', path: root, ok: true, skipped: false }]
    })
    expect(await readdir(root)).not.toContain('old.zip')
  })

  it('clears only unpinned input history through the protected store operation', async () => {
    const { clearInputHistory } = await import('./inputHistoryStore')
    const { cleanupData } = await import('./dataCleanupService')

    await expect(cleanupData({ input_history: true })).resolves.toEqual({
      items: [{ target: 'input_history', ok: true, skipped: false }]
    })
    expect(clearInputHistory).toHaveBeenCalledWith()
  })

  it('clears both application and Electron caches for the cache target', async () => {
    const clearElectronCache = vi.fn(async () => undefined)
    await mkdir(join(paths.cache, 'model_lists'), { recursive: true })
    await writeFile(join(paths.cache, 'model_lists', 'models.json'), '{}', 'utf8')
    const { cleanupData } = await import('./dataCleanupService')

    await expect(cleanupData(
      { cache_folder: true },
      { clearElectronCache }
    )).resolves.toEqual({
      items: [{ target: 'cache_folder', path: paths.cache, ok: true, skipped: false }]
    })
    await expect(readdir(root)).resolves.not.toContain('cache')
    expect(clearElectronCache).toHaveBeenCalledOnce()
  })

  it('reports Electron cache failures as a failed cache cleanup', async () => {
    const { cleanupData } = await import('./dataCleanupService')
    const result = await cleanupData(
      { cache_folder: true },
      { clearElectronCache: async () => { throw new Error('cache busy') } }
    )

    expect(result.items).toEqual([{
      target: 'cache_folder',
      ok: false,
      error: 'cache busy'
    }])
  })

  it('removes the complete developer HTTP trace directory', async () => {
    await mkdir(join(paths.developerHttpTrace, 'request-1'), { recursive: true })
    await writeFile(join(paths.developerHttpTrace, 'request-1', 'response-body.sse'), 'raw response', 'utf8')
    const { cleanupData } = await import('./dataCleanupService')

    await expect(cleanupData({ developer_http_trace: true })).resolves.toEqual({
      items: [{
        target: 'developer_http_trace',
        path: paths.developerHttpTrace,
        ok: true,
        skipped: false
      }]
    })
    await expect(readdir(join(root, 'dev'))).resolves.not.toContain('model-http')
  })
})
