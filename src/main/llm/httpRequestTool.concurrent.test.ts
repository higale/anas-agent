import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ root: '', target: '', checked: 0,
  checkedBoth: Promise.resolve(), releaseChecks: () => {}, committed: Promise.resolve(), releaseCommit: () => {} }))
vi.mock('../config/dataDir', async original => ({
  ...await original<typeof import('../config/dataDir')>(), getTempDir: () => join(state.root, 'registry')
}))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, access: async (...args: Parameters<typeof fs.access>) => {
    try { await fs.access(...args) } catch (error) {
      // Deliver two legitimate ENOENT observations together, exposing a stale
      // existence check without changing the real filesystem commit behavior.
      if (String(args[0]) === state.target && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (++state.checked === 2) { state.releaseChecks(); await state.committed }
        await state.checkedBoth
      }
      throw error
    }
  }, rename: async (...args: Parameters<typeof fs.rename>) => {
    await fs.rename(...args)
    if (String(args[1]) === state.target) state.releaseCommit()
  } }
})
import { executeHttpRequest } from './httpRequestTool'

afterEach(async () => { vi.unstubAllGlobals(); state.releaseChecks(); state.releaseCommit(); await rm(state.root, { recursive: true, force: true }) })

it('commits exactly one concurrent download when neither caller permits replacement', async () => {
  state.root = await mkdtemp(join(tmpdir(), 'anas-download-race-'))
  state.target = join(state.root, 'download.txt')
  state.checkedBoth = new Promise<void>(resolve => { state.releaseChecks = resolve })
  state.committed = new Promise<void>(resolve => { state.releaseCommit = resolve })
  let dispatched = 0, release!: () => void
  const bothDispatched = new Promise<void>(resolve => { release = resolve })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (++dispatched === 2) release()
    await bothDispatched
    return new Response(url)
  }))
  const sources = ['https://fixture.invalid/first', 'https://fixture.invalid/second']
  const results = await Promise.all(sources.map(url => executeHttpRequest({
    url, output_path: state.target, overwrite: false
  }, { primaryFolder: state.root }).then(value => JSON.parse(value))))
  expect(results.filter(result => result.ok)).toHaveLength(1)
  expect(results.filter(result => !result.ok)).toHaveLength(1)
  expect(await readFile(state.target, 'utf8')).toBe(sources[results.findIndex(result => result.ok)])
  expect((await readdir(state.root)).filter(name => name.includes('.anas-download-'))).toEqual([])
})
