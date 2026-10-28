import { randomUUID } from 'node:crypto'
import { posix, win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { decodePatchRecord, encodePatchDefinition, encodePatchMetadata, patchTextHash,
  validatePatchTransaction, type FilePatchEditRecord } from './filePatchRecord'
import { planFilePatchRestore } from './filePatchRestore'
import { cleanupFilePatchArtifacts, executePreparedFilePatchTransaction, resumeFilePatchTransaction } from './filePatchTransaction'

function record(root: string, paths: typeof posix): FilePatchEditRecord {
  const operationId = randomUUID(), file = paths.join(root, 'note.txt')
  const transaction: FilePatchEditRecord['transaction'] = {
    id: operationId, state: 'prepared', errors: [], directories: [], temporary: [], entries: [{
      before: {
        target: { requestedPath: 'note.txt', lexicalPath: file, canonicalPath: file, exists: true,
          finalIsSymbolicLink: false, operationIndex: 0, field: 'path', semantics: 'entry', access: 'write' },
        parent: { path: root, device: '1', inode: '2' }, text: 'before', hash: patchTextHash('before'),
        identity: { device: '1', inode: '3', size: 6, mode: 0o100644, modifiedNs: '1', changedNs: '1' }
      }, afterText: 'after', afterMode: undefined, after: null, state: 'pending'
    }]
  }
  return { tool: 'apply_patch', operationId, requestId: randomUUID(), createdAt: new Date(0).toISOString(),
    revision: 0, definitionHash: patchTextHash(encodePatchDefinition(transaction)), transaction }
}

describe('portable file change history', () => {
  it.each([
    { root: '/workspace', paths: posix },
    { root: 'C:\\workspace', paths: win32 },
    { root: '\\\\server\\share\\workspace', paths: win32 }
  ])('preserves paths and snapshots from $root on every host', async ({ root, paths }) => {
    const saved = record(root, paths)
    const definition = encodePatchDefinition(saved.transaction), metadata = encodePatchMetadata(saved)
    const decoded = await decodePatchRecord(JSON.parse(metadata), definition, async (_index, side) => side === 'before' ? 'before' : 'after')
    expect(encodePatchDefinition(decoded.transaction)).toBe(definition)
    expect(encodePatchMetadata(decoded)).toBe(metadata)
    expect(decoded.transaction.entries[0].before.target.canonicalPath).toBe(paths.join(root, 'note.txt'))
  })

  it('still rejects inconsistent historical parents, overlap and staging ownership', () => {
    const saved = record('C:\\workspace', win32)
    saved.transaction.entries[0].before.parent.path = 'D:\\workspace'
    expect(() => validatePatchTransaction(saved.transaction)).toThrow('snapshot identity')
    saved.transaction.entries[0].before.parent.path = 'c:\\WORKSPACE'
    expect(() => validatePatchTransaction(saved.transaction)).not.toThrow()
    const duplicate = structuredClone(saved.transaction.entries[0])
    duplicate.before.target.lexicalPath = duplicate.before.target.canonicalPath = 'c:\\WORKSPACE\\NOTE.txt'
    saved.transaction.entries.push(duplicate)
    expect(() => validatePatchTransaction(saved.transaction)).toThrow('overlap')
    saved.transaction.entries.pop()
    saved.transaction.temporary.push({ path: `D:\\outside\\.anas-patch-${saved.operationId}-part.tmp`, identity: null })
    expect(() => validatePatchTransaction(saved.transaction)).toThrow('outside its targets')
  })

  it('refuses foreign-platform restore, retry and cleanup before authorization or persistence', async () => {
    const foreign = process.platform === 'win32' ? posix : win32
    const saved = record(foreign === win32 ? 'C:\\workspace' : '/workspace', foreign)
    const temporary = foreign.join(foreign.dirname(saved.transaction.entries[0].before.target.canonicalPath),
      `.anas-patch-${saved.operationId}-part.tmp`)
    saved.transaction.temporary.push({ path: temporary, identity: { path: temporary, device: '1', inode: '4' } })
    const before = structuredClone(saved), authorize = vi.fn(), persist = vi.fn()
    expect(() => validatePatchTransaction(saved.transaction)).not.toThrow()
    await expect(planFilePatchRestore(saved, authorize)).rejects.toThrow('another platform')
    await expect(executePreparedFilePatchTransaction(saved.transaction, [], persist)).rejects.toThrow('another platform')
    await expect(resumeFilePatchTransaction(saved.transaction, [], persist)).rejects.toThrow('another platform')
    await expect(cleanupFilePatchArtifacts(saved.transaction)).rejects.toThrow('another platform')
    expect(authorize).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()
    expect(saved).toEqual(before)
  })
})
