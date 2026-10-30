import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { preserveRecoveryData, requireResettableConfigFile, resetRecoveryConfig } from './recoveryData'

const roots: string[] = []
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'anas-recovery-data-')))
  roots.push(root)
  const data = join(root, 'data')
  const bundled = join(root, 'bundled')
  await Promise.all([mkdir(data), mkdir(bundled)])
  return { root, data, bundled }
}
async function put(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value)
}
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('raw recovery data', () => {
  it('preserves broken JSON, database bytes and journals without parsing, and excludes transient roots', async () => {
    const { root, data } = await fixture()
    const files = {
      'config/settings.json': '{broken',
      'db/projects.json': 'not JSON',
      'db/input_history.json': 'input history',
      'projects.json': 'legacy data kept for manual rescue',
      'sqlite/agent.sqlite': 'not a database\u0000',
      'sqlite/agent.sqlite-wal': 'uncheckpointed data',
      'sqlite/agent.sqlite-shm': 'shared memory',
      'skills/test/SKILL.md': '# User skill',
      'log/current.log': 'error log'
    }
    for (const [name, value] of Object.entries(files)) await put(join(data, name), value)
    for (const name of ['electron', 'tmp', 'cache', 'dev']) await put(join(data, name, 'ignored'), 'transient')
    const output = await preserveRecoveryData(data, join(root, 'Anas', 'recovery'))
    expect(dirname(output)).toBe(join(root, 'Anas', 'recovery'))
    for (const [name, value] of Object.entries(files)) {
      expect(await readFile(join(output, 'data', name), 'utf8')).toBe(value)
      expect(await readFile(join(data, name), 'utf8')).toBe(value)
    }
    expect((await readdir(join(output, 'data'))).sort()).toEqual(['config', 'db', 'log', 'projects.json', 'skills', 'sqlite'])
    expect(JSON.parse(await readFile(join(output, 'recovery.json'), 'utf8')).source).toBe(data)
  })

  it('preserves folder links, dangling links and loops without following them', async () => {
    const { root, data } = await fixture()
    const external = join(root, 'external')
    await put(join(external, 'SKILL.md'), 'external skill')
    await symlink(external, join(data, 'external'), 'junction')
    await symlink('missing', join(data, 'dangling'), 'file')
    await symlink(data, join(data, 'loop'), 'junction')
    const output = await preserveRecoveryData(data, join(root, 'Anas', 'recovery'))
    for (const name of ['external', 'dangling', 'loop']) {
      expect((await lstat(join(output, 'data', name))).isSymbolicLink()).toBe(true)
      expect(await readlink(join(output, 'data', name))).toBe(await readlink(join(data, name)))
    }
  })

  it('rejects destinations inside the source, including linked destinations', async () => {
    const { root, data } = await fixture()
    const linked = join(root, 'linked')
    await symlink(data, linked, 'junction')
    await expect(preserveRecoveryData(data, data)).rejects.toThrow('outside')
    await expect(preserveRecoveryData(data, linked)).rejects.toThrow('outside')
    await expect(preserveRecoveryData(data, join(data, 'new', 'recovery'))).rejects.toThrow('outside')
    await expect(preserveRecoveryData(data, join(linked, 'new', 'recovery'))).rejects.toThrow('outside')
    expect(await readdir(data)).toEqual([])
  })

  it('keeps separate copies under the shared recovery directory', async () => {
    const { root, data } = await fixture()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-28T09:12:41.001Z'))
    await put(join(data, 'projects.json'), 'first')
    const first = await preserveRecoveryData(data, join(root, 'Anas', 'recovery'))
    await put(join(data, 'projects.json'), 'second')
    const second = await preserveRecoveryData(data, join(root, 'Anas', 'recovery'))
    expect(first).not.toBe(second)
    expect(basename(first)).toMatch(/^2026-10-28T09-12-41-001Z-/)
    expect(dirname(first)).toBe(join(root, 'Anas', 'recovery'))
    expect(dirname(second)).toBe(dirname(first))
    expect(await readFile(join(first, 'data/projects.json'), 'utf8')).toBe('first')
    expect(await readFile(join(second, 'data/projects.json'), 'utf8')).toBe('second')
    expect(await readdir(join(root, 'Anas', 'recovery'))).toHaveLength(2)
  })

  it('uses a redirected destination and leaves legacy copies untouched', async () => {
    const { root, data } = await fixture()
    const redirected = join(root, 'redirected')
    await mkdir(redirected)
    await symlink(redirected, join(root, 'documents'), 'junction')
    await put(join(root, 'Anas-Recovery', 'old', 'original'), 'old copy')
    await put(join(data, 'broken.json'), '{broken')
    const output = await preserveRecoveryData(data, join(root, 'documents', 'Anas', 'recovery'))
    expect(dirname(output)).toBe(join(redirected, 'Anas', 'recovery'))
    expect(await readFile(join(output, 'data', 'broken.json'), 'utf8')).toBe('{broken')
    expect(await readFile(join(root, 'Anas-Recovery', 'old', 'original'), 'utf8')).toBe('old copy')
  })

  it('reports an unavailable destination without modifying the source or falling back', async () => {
    const { root, data } = await fixture()
    await put(join(root, 'documents'), 'not a directory')
    await put(join(data, 'broken.json'), '{broken')
    await expect(preserveRecoveryData(data, join(root, 'documents', 'Anas', 'recovery'))).rejects.toThrow()
    expect(await readFile(join(data, 'broken.json'), 'utf8')).toBe('{broken')
    expect((await readdir(root)).sort()).toEqual(['bundled', 'data', 'documents'])
  })

  it('rejects a shared recovery directory linked back into the source', async () => {
    const { root, data } = await fixture()
    await mkdir(join(root, 'Anas'))
    await symlink(data, join(root, 'Anas', 'recovery'), 'junction')
    await expect(preserveRecoveryData(data, join(root, 'Anas', 'recovery'))).rejects.toThrow('outside')
    expect(await readdir(data)).toEqual([])
  })

  it('resets only the exact selected configuration after preserving the broken original', async () => {
    const { root, data, bundled } = await fixture()
    await put(join(data, 'config/settings.json'), '{broken')
    await put(join(data, 'config/models.json'), '{also broken')
    await put(join(data, 'projects.json'), 'keep projects')
    await put(join(bundled, 'settings.json'), '{"theme":"system"}')
    const output = await preserveRecoveryData(data, join(root, 'Anas', 'recovery'))
    await resetRecoveryConfig(data, bundled, 'settings.json')
    expect(await readFile(join(data, 'config/settings.json'), 'utf8')).toBe('{"theme":"system"}')
    expect(await readFile(join(output, 'data/config/settings.json'), 'utf8')).toBe('{broken')
    expect(await readFile(join(data, 'config/models.json'), 'utf8')).toBe('{also broken')
    expect(await readFile(join(data, 'projects.json'), 'utf8')).toBe('keep projects')
    expect((await readdir(join(data, 'config'))).sort()).toEqual(['models.json', 'settings.json'])
  })

  it('rejects unknown reset targets and unusable defaults without overwriting the original', async () => {
    const { data, bundled } = await fixture()
    for (const target of ['../projects.json', 'projects.json', '', null]) {
      expect(() => requireResettableConfigFile(target)).toThrow('exactly one')
    }
    await put(join(data, 'config/settings.json'), 'original')
    await put(join(bundled, 'settings.json'), 'invalid defaults')
    await expect(resetRecoveryConfig(data, bundled, 'settings.json')).rejects.toThrow()
    expect(await readFile(join(data, 'config/settings.json'), 'utf8')).toBe('original')
  })

  it('does not overwrite external files through a linked config directory or file', async () => {
    const { root, data, bundled } = await fixture()
    await put(join(root, 'external/settings.json'), 'external')
    await put(join(bundled, 'settings.json'), '{}')
    await symlink(join(root, 'external'), join(data, 'config'), 'junction')
    await expect(resetRecoveryConfig(data, bundled, 'settings.json')).rejects.toThrow('linked directory')
    await rm(join(data, 'config'))
    await mkdir(join(data, 'config'))
    await symlink(join(root, 'external/settings.json'), join(data, 'config/settings.json'), 'file')
    await expect(resetRecoveryConfig(data, bundled, 'settings.json')).rejects.toThrow('non-regular')
    expect(await readFile(join(root, 'external/settings.json'), 'utf8')).toBe('external')
  })
})
