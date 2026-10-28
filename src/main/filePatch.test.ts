import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defineContentTool } from '../runtime/toolDefinition'
import { modelToolDeclaration } from './agent/modelToolDeclarations'
import { filePatchSchema, parseFilePatch, planFilePatch, resolveFilePatchTargets } from './filePatch'
import { asPatchInput } from './filePatchTestFixtures'

const root = resolve('patch-fixture')
const path = join(root, '中文 name.txt')
const destination = join(root, 'new', 'moved.txt')
const temporary: string[] = []
const parse = (operations: Parameters<typeof asPatchInput>[0]['operations']) => parseFilePatch(asPatchInput({ operations }))
const update = (source: string, patch: string) => planFilePatch(parse([{ type: 'update', path, patch }]), new Map([[path, source]]))[0].afterText

afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true })
})

// Parsing/matching/line endings are checked against the Rust reference corpus
// in codexPatch.test.ts. These tests cover the host transaction boundary.
describe('patch transaction adapter', () => {
  it('bounds input/output and rejects binary or invalid Unicode text', () => {
    expect(() => update('a'.repeat(1_000_001), '@@\n+a')).toThrow('exceeds')
    expect(() => update('old\0', '@@\n+a')).toThrow('UTF-8')
    expect(() => update('\ud800', '@@\n+a')).toThrow('UTF-8')
    expect(() => update('x'.repeat(1_000_000), '@@\n+more')).toThrow('exceeds')
    expect(() => parse([{ type: 'update', path, patch: '@@\n+\ud800' }])).toThrow('UTF-8')
  })

  it('handles many untouched lines without spreading arrays onto the stack', () => {
    const before = '\n'.repeat(150_000) + 'last\n'
    expect(update(before, '@@\n-last\n+LAST')).toBe('\n'.repeat(150_000) + 'LAST\n')
  })

  it('retains the upstream syntax error and absolute patch line number', () => {
    const patch = ['*** Begin Patch', '*** Add File: first.txt', '+first', '*** Update File: second.txt',
      '*** Move to: moved.txt', '@@', 'unprefixed content', '*** End Patch'].join('\n')
    expect(() => parseFilePatch({ patch })).toThrow("invalid hunk at line 7, Unexpected line found in update hunk: 'unprefixed content'")
  })

  it('plans all four operations without writing or mutating input/snapshots', () => {
    const changed = join(root, 'update.txt'), removed = join(root, 'delete.txt'), moved = join(root, 'from.txt')
    const input = parse([
      { type: 'create', path, content: '' },
      { type: 'update', path: changed, patch: '@@\n-old\n+new' },
      { type: 'delete', path: removed },
      { type: 'move', path: moved, destination, patch: '@@\n-move\n+moved' }
    ])
    const original = structuredClone(input)
    const snapshots = new Map<string, string | null>([[path, null], [changed, 'old\n'], [removed, ''], [moved, 'move\n'], [destination, null]])
    const originalSnapshots = new Map(snapshots)
    expect(planFilePatch(input, snapshots)).toEqual([
      { operationIndex: 0, path, beforeText: null, afterText: '' },
      { operationIndex: 1, path: changed, beforeText: 'old\n', afterText: 'new\n' },
      { operationIndex: 2, path: removed, beforeText: '', afterText: null },
      { operationIndex: 3, path: moved, beforeText: 'move\n', afterText: null },
      { operationIndex: 3, path: destination, beforeText: null, afterText: 'moved\n' }
    ])
    expect(input).toEqual(original)
    expect(snapshots).toEqual(originalSnapshots)
  })

  it('can move an empty file using a context-only chunk', () => {
    expect(planFilePatch(parse([{ type: 'move', path, destination, patch: '@@\n ' }]), new Map([[path, ''], [destination, null]])))
      .toEqual([
        { operationIndex: 0, path, beforeText: '', afterText: null },
        { operationIndex: 0, path: destination, beforeText: null, afterText: '' }
      ])
  })

  it('reports the failing file without changing snapshots of earlier operations', () => {
    const snapshots = new Map([[path, null], [destination, 'actual\n']])
    expect(() => planFilePatch(parse([
      { type: 'create', path, content: 'valid\n' },
      { type: 'update', path: destination, patch: '@@\n-absent\n+new' }
    ]), snapshots)).toThrow(`Failed to find expected lines in ${destination}`)
    expect(snapshots.get(path)).toBeNull()
  })

  it('rejects missing sources, occupied destinations and missing snapshots', () => {
    expect(() => planFilePatch(parse([{ type: 'create', path, content: 'new\n' }]), new Map([[path, 'old\n']]))).toThrow('already exists')
    expect(() => planFilePatch(parse([{ type: 'delete', path }]), new Map([[path, null]]))).toThrow('does not exist')
    expect(() => planFilePatch(parse([{ type: 'update', path, patch: '@@\n+a' }]), new Map([[path, null]]))).toThrow('does not exist')
    expect(() => planFilePatch(parse([{ type: 'delete', path }]), new Map())).toThrow('snapshot is missing')
    expect(() => planFilePatch(parse([{ type: 'move', path, destination, patch: '@@\n ' }]), new Map([[path, ''], [destination, '']])))
      .toThrow('destination already exists')
  })

  it('rejects repeated, nested and chained transaction targets', () => {
    const batches: Parameters<typeof parse>[0][] = [
      [{ type: 'delete', path }, { type: 'create', path, content: '' }],
      [{ type: 'move', path, destination: path, patch: '@@\n old' }],
      [{ type: 'move', path, destination, patch: '@@\n old' }, { type: 'delete', path: destination }],
      [{ type: 'create', path, content: '' }, { type: 'create', path: join(path, 'child'), content: '' }]
    ]
    for (const batch of batches) expect(() => planFilePatch(parse(batch), new Map())).toThrow('overlap')
  })

  it('rejects resource excess and unsupported transaction fields', () => {
    expect(() => parseFilePatch({ patch: '*** Begin Patch\n*** Environment ID: remote\n*** Delete File: file\n*** End Patch' }))
      .toThrow('environment selection is not supported')
    expect(() => parse([{ type: 'create', path, content: '中'.repeat(400_000) }])).toThrow('exceeds')
    expect(() => parse(Array.from({ length: 21 }, () => ({ type: 'delete', path })))).toThrow()
    expect(() => parse([{ type: 'delete', path: 'bad\0path' }])).toThrow('UTF-8')
    expect(() => parseFilePatch({ patch: '*** Begin Patch\n*** End Patch' })).toThrow()
    expect(() => parseFilePatch({ operations: [{ type: 'delete', path }] })).toThrow()
    expect(() => planFilePatch({ operations: [{ type: 'delete', path, recursive: true }] }, new Map())).toThrow()
    const snapshots = new Map(Array.from({ length: 5 }, (_, index) => [`${path}${index}`, 'a'.repeat(900_000)]))
    expect(() => planFilePatch(parse([...snapshots.keys()].map((path) => ({ type: 'delete', path }))), snapshots)).toThrow('snapshots exceed')
    expect(() => parse(Array.from({ length: 5 }, (_, index) => ({ type: 'create', path: `${path}${index}`, content: 'a'.repeat(900_000) })))).toThrow()
  })

  it('resolves dry runs as reads and actual patches as writes', async () => {
    for (const dry_run of [true, false]) {
      const result = await resolveFilePatchTargets({ ...asPatchInput({ operations: [{ type: 'move', path: 'from.txt', destination: 'to.txt', patch: '@@\n old' }] }), dry_run }, root)
      expect(result.targets.map((target) => target.access)).toEqual([dry_run ? 'read' : 'write', dry_run ? 'read' : 'write'])
    }
  })

  it('exposes the patch document, not the private transaction plan', () => {
    const definition = modelToolDeclaration(defineContentTool({ name: 'apply_patch', description: 'Apply text edits.', inputSchema: filePatchSchema, execute: async () => 'unused' }))
    const schema = JSON.stringify(definition)
    expect(schema).toContain('patch')
    expect(schema).not.toContain('"operations"')
    expect(schema).not.toContain('"chunks"')
  })

  it('resolves all source/destination paths without mutating the public arguments', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'anas-patch-paths-')))
    temporary.push(directory)
    const input = asPatchInput({ operations: [{ type: 'move', path: 'from.txt', destination: 'new/to.txt', patch: '@@\n old' }] })
    const original = structuredClone(input)
    const result = await resolveFilePatchTargets(input, directory)
    expect(result.targets).toEqual([
      expect.objectContaining({ operationIndex: 0, field: 'path', canonicalPath: join(directory, 'from.txt'), semantics: 'entry' }),
      expect.objectContaining({ operationIndex: 0, field: 'destination', canonicalPath: join(directory, 'new', 'to.txt'), access: 'write' })
    ])
    expect(input).toEqual(original)
  })

  it('rejects aliased targets through a linked parent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'anas-patch-alias-'))
    temporary.push(directory)
    await mkdir(join(directory, 'real'))
    await symlink(join(directory, 'real'), join(directory, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(resolveFilePatchTargets(asPatchInput({ operations: [
      { type: 'create', path: 'real/file.txt', content: '' }, { type: 'create', path: 'link/file.txt', content: '' }
    ] }), directory)).rejects.toThrow('overlap')
  })
})
