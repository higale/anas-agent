import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { saveToolResultFile } from './toolResultFile'
import { withApplicationDataSnapshot } from '../applicationDataSnapshot'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'anas-tool-result-file-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it('preserves Unicode and whitespace, reuses identical content and repairs a modified cache', async () => {
  const content = '头部\r\n\t🐟'.repeat(10000) + '\n结尾 '
  const paths = await Promise.all([saveToolResultFile(content, root), saveToolResultFile(content, root)])
  expect(paths[0]).toBe(paths[1])
  expect(await readFile(paths[0], 'utf8')).toBe(content)
  await writeFile(paths[0], 'changed')
  expect(await saveToolResultFile(content, root)).toBe(paths[0])
  expect(await readFile(paths[0], 'utf8')).toBe(content)
  expect(await readdir(root)).toHaveLength(1)
})

it('reports a failed write instead of returning a nonexistent file reference', async () => {
  const blocked = join(root, 'not-a-directory')
  await writeFile(blocked, 'preserve')
  await expect(saveToolResultFile('full output', blocked)).rejects.toThrow()
  expect(await readFile(blocked, 'utf8')).toBe('preserve')
})

it('keeps backup snapshots isolated from publication and temporary files', async () => {
  let release!: () => void
  let started!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const entered = new Promise<void>(resolve => { started = resolve })
  const snapshot = withApplicationDataSnapshot(async () => { started(); await pending })
  await entered
  const saving = saveToolResultFile('complete result', root)
  try { expect(await readdir(root)).toEqual([]) }
  finally { release() }
  await snapshot
  const path = await saving
  const nextWrite = saveToolResultFile('another result', root)
  await withApplicationDataSnapshot(async () => {
    const files = await readdir(root)
    expect(files).toHaveLength(2)
    expect(files.every(name => name.endsWith('.txt'))).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('complete result')
  })
  await nextWrite
})
