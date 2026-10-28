import { toolEffectArtifactPurposes, type ToolEffectArtifactIdentity } from '../runtime/toolEffectIdentity'
import type { ExecutionToolCall } from '../runtime/executionState'
import { encodeExecutionValue, decodeExecutionValue } from '../runtime/executionValue'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeExecutionStore, nativeExecutionSchema } from './agent/nativeExecutionStore'
import { runWithCurrentAgentToolEffect, type CurrentAgentToolEffectScope } from './agent/toolEffectScope'
import { FileEditStore } from './fileEditStore'
import { resolveFilePatchTargets } from './filePatch'
import { asPatchInput } from './filePatchTestFixtures'
import { captureFilePatchPreimages } from './filePatchState'
import { executeFilePatchTransaction, type FilePatchTransaction } from './filePatchTransaction'

const roots: string[] = [], databases = new Set<Database.Database>()
afterEach(async () => {
  for (const database of databases) database.close()
  databases.clear()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(purpose: 'file_edit' | 'file_restore' = 'file_edit') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'anas-patch-preparation-')))
  roots.push(root)
  const workspace = join(root, 'workspace'), databasePath = join(root, 'agent.sqlite')
  await mkdir(workspace)
  await writeFile(join(workspace, 'old.txt'), 'before\n')
  let raw = new Database(databasePath)
  raw.exec(nativeExecutionSchema)
  databases.add(raw)
  let database = new NativeExecutionStore(raw)
  const thread = { id: randomUUID() }, run = { id: randomUUID() }
  const key = { threadId: thread.id, runId: run.id, callId: 'call' }
  const identity: ToolEffectArtifactIdentity = { runId: run.id,
    artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, randomUUID()])) as ToolEffectArtifactIdentity['artifacts'] }
  const call: ExecutionToolCall = { id: key.callId, providerCallId: key.callId, name: purpose === 'file_edit' ? 'apply_patch' : 'restore_file_edit', args: {}, artifacts: identity.artifacts }
  const operationId = identity.artifacts[purpose], store = new FileEditStore(join(root, 'records'))
  const context = { modelCalls: 0, todos: [] }
  database.start({ threadId: thread.id, runId: run.id, messages: [{ id: 'input', value: { kind: 'user', content: 'Edit the requested file.' } }], context })
  const commitScope = () => ({ ...key, expectedRevisionId: database.load(thread.id)!.revisionId })
  database.acceptModel(commitScope(), { id: 'response', value: { kind: 'assistant', content: '', calls: [{ id: call.id, name: call.name, args: call.args }] } }, [call], context)
  database.prepareTools(commitScope(), [{ callId: call.id, args: call.args }])
  database.prepareEffect(key, 'confirm')
  const scope: CurrentAgentToolEffectScope = {
    identity,
    isUnarmed: () => { const row = database.loadEffect(key); return row?.state === 'prepared' && row.effectAttempt === 0 },
    arm: (effect) => { database.armEffect(key, effect) }
  }
  const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [{ type: 'update', path: 'old.txt', patch: '@@\n-before\n+after\n' }] }), workspace)
  const preimages = await captureFilePatchPreimages(resolved.targets)
  const directory = store.editRecordDir(run.id, operationId)
  const partial = async () => { await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'partial'), 'keep until proved unarmed') }
  const lookup = () => store.loadPatchForExecution(operationId, run.id, purpose)
  const reopen = () => { raw.close(); databases.delete(raw); raw = new Database(databasePath); databases.add(raw); database = new NativeExecutionStore(raw) }
  const prepared = async () => {
    let record!: FilePatchTransaction
    await expect(executeFilePatchTransaction(operationId, resolved.input, preimages, async (snapshot) => {
      record = structuredClone(snapshot)
      throw new Error('prepared only')
    })).rejects.toThrow('prepared only')
    await store.createPatchPersistence(run.id, operationId).persist(record)
  }
  return { root, workspace, key, run, store, scope, operationId, directory, partial, lookup, reopen, prepared, databasePath,
    get database() { return database }, input: resolved.input, preimages }
}

// Preparation writes durable metadata, matching the restore/resume suites' disk budget.
describe('patch preparation and durable unarmed proof', { timeout: 20_000 }, () => {
  it.each(['file_edit', 'file_restore'] as const)('discards only unpublished %s preparation after reopening an unarmed journal', async (purpose) => {
    const value = await fixture(purpose)
    await value.partial()
    const sibling = join(value.store.editRecordsDir(value.run.id), randomUUID())
    await mkdir(sibling)
    await writeFile(join(sibling, 'keep'), 'other operation')
    value.reopen()
    expect(await runWithCurrentAgentToolEffect(value.scope, value.lookup)).toBeUndefined()
    await expect(stat(value.directory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await runWithCurrentAgentToolEffect(value.scope, value.lookup)).toBeUndefined()
    expect(await readFile(join(sibling, 'keep'), 'utf8')).toBe('other operation')
    expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe('before\n')
    expect(value.database.loadEffect(value.key)).toMatchObject({ state: 'prepared', effectAttempt: 0 })
  })

  it('creates a fresh edit using the same stable identity only after certified preparation cleanup', async () => {
    const value = await fixture()
    await value.partial()
    value.reopen()
    await runWithCurrentAgentToolEffect(value.scope, async () => {
      expect(await value.lookup()).toBeUndefined()
      const result = await value.store.executePatch(value.input, value.preimages, value.run.id)
      expect(result.operationId).toBe(value.operationId)
      expect(result.transaction.state).toBe('applied')
      expect(await value.lookup()).toEqual(result)
    })
    expect(value.database.loadEffect(value.key)).toMatchObject({ state: 'intent', effectAttempt: 1 })
    expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe('after\n')
  })

  it('restarts an unpublished reverse preparation without replacing the source snapshots', async () => {
    const value = await fixture('file_restore')
    const source = await value.store.executePatch(value.input, value.preimages, value.run.id, { operationId: randomUUID() })
    await value.partial()
    value.reopen()
    await runWithCurrentAgentToolEffect(value.scope, async () => {
      expect(await value.lookup()).toBeUndefined()
      const inverse = await value.store.restorePatch(source.operationId, source.requestId, value.run.id, async () => {})
      expect(inverse?.operationId).toBe(value.operationId)
      expect(inverse?.transaction.state).toBe('applied')
    })
    expect(await value.store.loadOperationRecord(source.operationId, source.requestId)).toMatchObject({
      definitionHash: source.definitionHash, transaction: { entries: source.transaction.entries }
    })
    expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe('before\n')
    expect(value.database.loadEffect(value.key)).toMatchObject({ state: 'intent', effectAttempt: 1 })
  })

  it.each(['absent', 'partial'] as const)('refuses %s preparation after an effect boundary, including a confirmed retry', async (kind) => {
    const value = await fixture()
    if (kind === 'partial') await value.partial()
    value.database.armEffect(value.key, { kind: 'file_patch', target: {} })
    value.reopen()
    await expect(runWithCurrentAgentToolEffect(value.scope, value.lookup)).rejects.toThrow('unarmed effect journal')
    value.database.retryEffect(value.key, { kind: 'approved', expectedConfirmationCount: 0 })
    value.reopen()
    expect(value.database.loadEffect(value.key)).toMatchObject({ state: 'prepared', effectAttempt: 1 })
    await expect(runWithCurrentAgentToolEffect(value.scope, value.lookup)).rejects.toThrow('unarmed effect journal')
    if (kind === 'partial') expect(await readFile(join(value.directory, 'partial'), 'utf8')).toBe('keep until proved unarmed')
    expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe('before\n')
  })

  it.each(['no-scope', 'no-journal', 'wrong-artifact', 'wrong-purpose', 'wrong-run'] as const)('preserves unpublished evidence with %s', async (kind) => {
    const value = await fixture()
    await value.partial()
    if (kind === 'no-journal') value.database.discardUnarmedEffect(value.key)
    const scope = { ...value.scope, identity: { ...value.scope.identity!,
      ...(kind === 'wrong-artifact' ? { artifacts: { ...value.scope.identity!.artifacts, file_edit: randomUUID() } }
        : kind === 'wrong-run' ? { runId: randomUUID() } : {}) } }
    const lookup = kind === 'wrong-purpose' ? () => value.store.loadPatchForExecution(value.operationId, value.run.id, 'file_restore') : value.lookup
    await expect(kind === 'no-scope' ? lookup() : runWithCurrentAgentToolEffect(scope, lookup)).rejects.toThrow('unarmed effect journal')
    expect(await readFile(join(value.directory, 'partial'), 'utf8')).toBe('keep until proved unarmed')
  })

  it('rejects changed saved input before treating existing preparation as unarmed', async () => {
    const value = await fixture()
    await value.partial()
    const raw = new Database(value.databasePath)
    try {
      const saved = raw.prepare('SELECT call_value FROM execution_calls WHERE thread_id = ? AND call_id = ?')
        .get(value.key.threadId, value.key.callId) as { call_value: Uint8Array }
      const call = decodeExecutionValue(saved.call_value) as Record<string, unknown>
      raw.prepare('UPDATE execution_calls SET call_value = ? WHERE thread_id = ? AND call_id = ?')
        .run(encodeExecutionValue({ ...call, args: { changed: true } }), value.key.threadId, value.key.callId)
    } finally { raw.close() }
    value.reopen()
    expect(() => value.database.prepareEffect(value.key, 'confirm')).toThrow('immutable call identity')
    expect(value.database.loadEffect(value.key)).toMatchObject({ argsJson: '{}', state: 'prepared', effectAttempt: 0 })
    expect(await readFile(join(value.directory, 'partial'), 'utf8')).toBe('keep until proved unarmed')
    expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe('before\n')
  })

  it.each(['metadata', 'definition', 'snapshot'] as const)('does not reset damaged published %s even before an effect boundary', async (kind) => {
    const value = await fixture()
    await value.prepared()
    if (kind === 'metadata') await writeFile(join(value.directory, 'record.json'), '{broken')
    else {
      const file = join(value.directory, kind === 'definition' ? 'definition.json' : '0.before.txt')
      await rename(file, `${file}.test-hidden`)
    }
    value.reopen()
    await expect(runWithCurrentAgentToolEffect(value.scope, value.lookup)).rejects.toThrow()
    expect((await stat(value.directory)).isDirectory()).toBe(true)
    expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe('before\n')
  })

  it('keeps complete prepared records intact for explicit resumption', async () => {
    const value = await fixture()
    await value.prepared()
    const before = await value.store.loadOperationRecord(value.operationId, value.run.id)
    value.reopen()
    expect(await runWithCurrentAgentToolEffect(value.scope, value.lookup)).toEqual(before)
    expect(await value.lookup()).toEqual(before)
  })

  it('does not follow a linked operation directory while discarding preparation', async () => {
    const value = await fixture()
    const target = join(value.root, 'outside')
    await mkdir(target)
    await writeFile(join(target, 'keep'), 'outside')
    await mkdir(value.store.editRecordsDir(value.run.id), { recursive: true })
    await symlink(target, value.directory, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(runWithCurrentAgentToolEffect(value.scope, value.lookup)).rejects.toThrow()
    expect(await readFile(join(target, 'keep'), 'utf8')).toBe('outside')
  })
})
