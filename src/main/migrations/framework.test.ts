import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as atomic from '../atomicJson'
import { runJsonMigrations, type JsonMigration } from './framework'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'anas-migrations-')) })
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

function migration(name: string): JsonMigration {
  return {
    path: join(root, name), currentVersion: 2,
    steps: [
      { from: 0, to: 1, upgrade: d => ({ ...d, version: 1, label: d.name }) },
      { from: 1, to: 2, upgrade: d => ({ ...d, version: 2, entries: [d.label] }) }
    ],
    validateCurrent: d => {
      if (!Array.isArray(d.entries) || d.entries.some(x => typeof x !== 'string')) throw new Error('Invalid entries')
    }
  }
}

describe('independent JSON migrations', () => {
  it('skips upgrade callbacks and target validation when the data version is current', async () => {
    const plan = migration('settings.json')
    const upgrade = vi.fn(() => { throw new Error('No upgrade should run') })
    const validateCurrent = vi.fn(() => { throw new Error('No migration validation should run') })
    const raw = '{"version":2,"entries":["existing"]}'
    await writeFile(plan.path, raw)
    await runJsonMigrations([{ ...plan, steps: [{ from: 0, to: 2, upgrade }], validateCurrent }])
    expect(upgrade).not.toHaveBeenCalled()
    expect(validateCurrent).not.toHaveBeenCalled()
    expect(await readFile(plan.path, 'utf8')).toBe(raw)
    expect(await readdir(root)).toEqual(['settings.json'])
  })

  it('chains skipped versions, preserves unknown fields, and does nothing on a second run', async () => {
    const plan = migration('settings.json')
    const raw = '{"version":0,"name":"existing","selection":"stable-id"}'
    await writeFile(plan.path, raw)
    await runJsonMigrations([plan])
    expect(JSON.parse(await readFile(plan.path, 'utf8'))).toEqual({ name: 'existing', selection: 'stable-id', version: 2, label: 'existing', entries: ['existing'] })
    expect(await readFile(`${plan.path}.v0.bak`, 'utf8')).toBe(raw)
    const current = await readFile(plan.path, 'utf8')
    await runJsonMigrations([plan])
    expect(await readFile(plan.path, 'utf8')).toBe(current)
    expect((await readdir(root)).sort()).toEqual(['settings.json', 'settings.json.v0.bak'])
  })

  it.each([
    '{"version":3}',
    '{"version":null}',
    '{"version":1,"label":42}'
  ])('preflights all files before changing any: %s', async invalid => {
    const first = migration('first.json'), second = migration('second.json')
    const raw = '{"version":0,"name":"old"}'
    await writeFile(first.path, raw)
    await writeFile(second.path, invalid)
    await expect(runJsonMigrations([first, second])).rejects.toThrow()
    expect(await readFile(first.path, 'utf8')).toBe(raw)
    expect(await readFile(second.path, 'utf8')).toBe(invalid)
    expect((await readdir(root)).sort()).toEqual(['first.json', 'second.json'])
  })

  it('resumes after one file committed and the next atomic write failed', async () => {
    const first = migration('first.json'), second = migration('second.json')
    const raw = '{"version":1,"label":"existing"}'
    await writeFile(first.path, raw)
    await writeFile(second.path, raw)
    const write = atomic.writeJsonFileAtomic
    vi.spyOn(atomic, 'writeJsonFileAtomic').mockImplementationOnce(write).mockRejectedValueOnce(new Error('Disk full'))
    await expect(runJsonMigrations([first, second])).rejects.toThrow('Disk full')
    const committed = await readFile(first.path, 'utf8')
    expect(JSON.parse(committed).version).toBe(2)
    expect(await readFile(second.path, 'utf8')).toBe(raw)
    await runJsonMigrations([first, second])
    expect(await readFile(first.path, 'utf8')).toBe(committed)
    expect(JSON.parse(await readFile(second.path, 'utf8')).version).toBe(2)
    expect(await readFile(`${first.path}.v1.bak`, 'utf8')).toBe(raw)
    expect(await readFile(`${second.path}.v1.bak`, 'utf8')).toBe(raw)
  })

  it('rejects a missing upgrade path without modifying the source', async () => {
    const plan = migration('settings.json')
    plan.steps = plan.steps.slice(1)
    const raw = '{"version":0,"name":"existing"}'
    await writeFile(plan.path, raw)
    await expect(runJsonMigrations([plan])).rejects.toThrow('Missing migration')
    expect(await readFile(plan.path, 'utf8')).toBe(raw)
    expect(await readdir(root)).toEqual(['settings.json'])
  })

  it('rejects a conflicting backup without overwriting either file', async () => {
    const plan = migration('settings.json')
    const raw = '{"version":0,"name":"existing"}'
    await writeFile(plan.path, raw)
    await writeFile(`${plan.path}.v0.bak`, 'different original')
    await expect(runJsonMigrations([plan])).rejects.toThrow('backup differs')
    expect(await readFile(plan.path, 'utf8')).toBe(raw)
    expect(await readFile(`${plan.path}.v0.bak`, 'utf8')).toBe('different original')
    expect((await readdir(root)).sort()).toEqual(['settings.json', 'settings.json.v0.bak'])
  })

  it('rejects ambiguous or incorrect step definitions before writing', async () => {
    const plan = migration('settings.json')
    const raw = '{"version":0,"name":"existing"}'
    await writeFile(plan.path, raw)
    await expect(runJsonMigrations([plan, plan])).rejects.toThrow('Duplicate')
    await expect(runJsonMigrations([{ ...plan, steps: [...plan.steps, plan.steps[0]] }])).rejects.toThrow('Invalid migration steps')
    await expect(runJsonMigrations([{ ...plan, steps: [{ from: 0, to: 2, upgrade: d => d }] }])).rejects.toThrow('incorrect version')
    expect(await readFile(plan.path, 'utf8')).toBe(raw)
    expect(await readdir(root)).toEqual(['settings.json'])
  })

  it('propagates file read errors instead of treating unreadable data as a new installation', async () => {
    const plan = migration('settings.json')
    await mkdir(plan.path)
    await expect(runJsonMigrations([plan])).rejects.toThrow()
  })
})
