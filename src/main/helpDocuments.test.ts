import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { helpDocuments } from '@shared/helpDocuments'

const paths = vi.hoisted(() => ({ root: '', bundled: '', data: '' }))
vi.mock('./config/dataDir', () => ({
  getDataDir: () => paths.data,
  getBundledDataDir: () => paths.bundled
}))
import { readHelpDocument } from './helpDocuments'

beforeEach(async () => {
  paths.root = await mkdtemp(join(tmpdir(), 'anas-help-'))
  paths.data = join(paths.root, 'user')
  paths.bundled = join(paths.root, 'bundled')
  await cp(resolve('data/help'), join(paths.bundled, 'help'), { recursive: true })
})
afterEach(async () => { await rm(paths.root, { recursive: true, force: true }) })

describe('bundled help documents', () => {
  it('reads every document directly and ignores unchanged legacy copies', async () => {
    for (const id of Object.keys(helpDocuments)) {
      expect(await readHelpDocument(id)).toBe(await readFile(join('data/help', id), 'utf8'))
    }
    await expect(readdir(paths.data)).rejects.toMatchObject({ code: 'ENOENT' })
    await mkdir(join(paths.data, 'help'), { recursive: true })
    const legacy = join(paths.data, 'help/USER_GUIDE.en.md')
    await writeFile(legacy, 'Old help')
    expect(await readHelpDocument('USER_GUIDE.en.md')).not.toBe('Old help')
    expect(await readFile(legacy, 'utf8')).toBe('Old help')
  })
  it.each(['../config/app.json', '', null, {}, '/USER_GUIDE.en.md'])('rejects an unknown document %j', async id => {
    await expect(readHelpDocument(id)).rejects.toThrow('Unknown help document')
  })
  it('reports missing and oversized bundled documents without falling back to user copies', async () => {
    const file = join(paths.bundled, 'help/USER_GUIDE.en.md')
    await writeFile(file, Buffer.alloc(1024 * 1024 + 1))
    await expect(readHelpDocument('USER_GUIDE.en.md')).rejects.toThrow('too large')
    await rm(file)
    await expect(readHelpDocument('USER_GUIDE.en.md')).rejects.toThrow()
  })
})
