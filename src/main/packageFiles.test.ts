import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile, readFile, rm, stat, symlink, unlink, readdir, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as fs from 'node:fs/promises'
import { createPackageFile, packageFileExists, listPackageFiles, readPackageFile, savePackageFile } from './packageFiles'
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'package-edit-')) })
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })
async function fixture() {
  await writeFile(join(root, 'run.py'), '\ufeffprint("before")\r\n')
  await chmod(join(root, 'run.py'), 0o755)
  return readPackageFile(root, 'run.py')
}
describe.each([
  { platform: 'darwin', hidden: ['.DS_Store', '.localized', '._run.py', '__MACOSX'], visible: ['Thumbs.db', 'Desktop.ini', '.directory'] },
  { platform: 'win32', hidden: ['Thumbs.db', 'Desktop.ini'], visible: ['.DS_Store', '.localized', '._run.py', '__MACOSX', '.directory'] },
  { platform: 'linux', hidden: ['.directory'], visible: ['.DS_Store', '.localized', '._run.py', '__MACOSX', 'Thumbs.db', 'Desktop.ini'] }
])('package file listing on $platform', ({ platform, hidden, visible }) => {
  it.each([undefined, 'scripts'])('hides only native system metadata and retains useful hidden files in %s', async relativePath => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
    try {
      const directory = relativePath ? join(root, relativePath) : root
      await mkdir(directory, { recursive: true })
      const files = ['.DS_Store', '.localized', '._run.py', 'Thumbs.db', 'Desktop.ini', '.directory', '.env', '.gitignore', 'run.py']
      await Promise.all(files.map(name => writeFile(join(directory, name), 'content')))
      await Promise.all(['__MACOSX', '.git', '.config'].map(name => mkdir(join(directory, name))))

      const nodes = await listPackageFiles(root, relativePath)
      expect(nodes.map(node => node.name).sort()).toEqual([...visible, '.config', '.env', '.gitignore', 'run.py'].sort())
      expect(nodes[0].kind).toBe('directory')
      expect(nodes.map(node => node.relativePath)).toEqual(nodes.map(node => relativePath ? `${relativePath}/${node.name}` : node.name))
      expect(await readdir(directory)).toEqual(expect.arrayContaining(hidden))
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  })
})
describe('package file saving', () => {
  it('creates missing parent directories and an empty editable file without overwriting an existing file', async () => {
    expect(await packageFileExists(root, 'scripts/nested/run.py')).toBe(false)
    const created = await createPackageFile(root, 'scripts/nested/run.py')
    expect(created).toMatchObject({ relativePath: 'scripts/nested/run.py', content: '', kind: 'text', size: 0 })
    expect(created.revision).toBeTruthy()
    expect(await packageFileExists(root, 'scripts/nested/run.py')).toBe(true)
    await writeFile(join(root, 'scripts/nested/run.py'), 'keep this')
    await expect(createPackageFile(root, 'scripts/nested/run.py')).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(join(root, 'scripts/nested/run.py'), 'utf8')).toBe('keep this')
  })
  it('rejects creation outside the package and treats an invalid parent as an error, not a missing file', async () => {
    await expect(createPackageFile(root, '../escaped.py')).rejects.toThrow('invalid')
    await expect(packageFileExists(root, '../escaped.py')).rejects.toThrow('invalid')
    await writeFile(join(root, 'scripts'), 'not a directory')
    for (const path of ['scripts/run.py', 'scripts/nested/run.py']) {
      await expect(packageFileExists(root, path)).rejects.toMatchObject({ code: 'ENOTDIR' })
      await expect(createPackageFile(root, path)).rejects.toThrow('not a directory')
    }
    expect(await readFile(join(root, 'scripts'), 'utf8')).toBe('not a directory')
  })
  it.skipIf(process.platform === 'win32')('does not create through a directory link outside the package or replace a dangling file link', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'package-create-outside-'))
    try {
      await symlink(outside, join(root, 'scripts'), 'dir')
      await expect(createPackageFile(root, 'scripts/nested/run.py')).rejects.toThrow('outside')
      expect(await readdir(outside)).toEqual([])
      await symlink(join(root, 'missing.py'), join(root, 'link.py'))
      expect(await packageFileExists(root, 'link.py')).toBe(true)
      await expect(createPackageFile(root, 'link.py')).rejects.toMatchObject({ code: 'EEXIST' })
    } finally { await rm(outside, { recursive: true, force: true }) }
  })
  it('saves UTF-8 text atomically and preserves executable permission, BOM and line endings', async () => {
    const before = await fixture()
    const content = '\ufeffprint("after")\r\n'
    const after = await savePackageFile(root, 'run.py', { content, revision: before.revision!, resolvedPath: before.resolvedPath })
    expect(after.content).toBe(content)
    expect(after.revision).not.toBe(before.revision)
    expect(await readFile(join(root, 'run.py'), 'utf8')).toBe(content)
    if (process.platform !== 'win32') expect((await stat(join(root, 'run.py'))).mode & 0o777).toBe(0o755)
    expect(await readdir(root)).toEqual(['run.py'])
  })
  it('rejects stale or competing saves without overwriting external content', async () => {
    const before = await fixture()
    const update = { content: 'first', revision: before.revision!, resolvedPath: before.resolvedPath }
    const results = await Promise.allSettled([savePackageFile(root, 'run.py', update), savePackageFile(root, 'run.py', { ...update, content: 'second' })])
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected'])
    await writeFile(join(root, 'run.py'), 'external')
    await expect(savePackageFile(root, 'run.py', update)).rejects.toThrow('changed outside')
    expect(await readFile(join(root, 'run.py'), 'utf8')).toBe('external')
  })
  it.skipIf(process.platform === 'win32')('preserves symlinks and rejects changed link targets', async () => {
    const before = await fixture()
    await symlink(join(root, 'run.py'), join(root, 'link.py'))
    const link = await readPackageFile(root, 'link.py')
    await savePackageFile(root, 'link.py', { content: 'saved', revision: link.revision!, resolvedPath: link.resolvedPath })
    expect((await fs.lstat(join(root, 'link.py'))).isSymbolicLink()).toBe(true)
    await writeFile(join(root, 'other.py'), before.content!)
    await unlink(join(root, 'link.py'))
    await symlink(join(root, 'other.py'), join(root, 'link.py'))
    await expect(savePackageFile(root, 'link.py', { content: 'oops', revision: before.revision!, resolvedPath: before.resolvedPath })).rejects.toThrow('changed outside')
    expect(await readFile(join(root, 'other.py'), 'utf8')).toBe(before.content)
  })
  it('preserves the original and removes staging files on commit failure', async () => {
    const before = await fixture()
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error('Disk failure'))
    await expect(savePackageFile(root, 'run.py', { content: 'replacement', revision: before.revision!, resolvedPath: before.resolvedPath })).rejects.toThrow('Disk failure')
    expect(await readFile(join(root, 'run.py'), 'utf8')).toBe(before.content)
    expect(await readdir(root)).toEqual(['run.py'])
  })
  it('does not edit binary, invalid UTF-8, oversized or out-of-package input', async () => {
    await writeFile(join(root, 'bad.py'), Buffer.from([0xff, 0xfe]))
    expect((await readPackageFile(root, 'bad.py')).kind).toBe('binary')
    const before = await fixture()
    const update = { content: 'x'.repeat(1024 * 1024 + 1), revision: before.revision!, resolvedPath: before.resolvedPath }
    await expect(savePackageFile(root, 'run.py', update)).rejects.toThrow('Invalid')
    await expect(savePackageFile(root, '../run.py', { ...update, content: 'x' })).rejects.toThrow('path')
    expect(await readFile(join(root, 'run.py'), 'utf8')).toBe(before.content)
  })
})
