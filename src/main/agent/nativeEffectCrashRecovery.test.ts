import Database from 'better-sqlite3'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { nativeEffectCrashExitCode, runNativeEffectCrashHarness, type NativeEffectCrashOptions } from './nativeEffectCrashHarness'
import { FileEditStore } from '../fileEditStore'
import { FileChangeLedger } from './fileChangeLedger'
import { toolResultText } from '../../runtime/toolResultMessage'
import { resolveFilePatchTargets } from '../filePatch'
import { asPatchInput } from '../filePatchTestFixtures'
import { captureFilePatchPreimages } from '../filePatchState'

const roots: string[] = []
function fixture(): NativeEffectCrashOptions {
  const parent = join(process.cwd(), 'tmp'); mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, 'native-effect-crash-')); roots.push(root)
  return { root, threadId: randomUUID(), runId: randomUUID(), fault: 'none' }
}
function crash(options: NativeEffectCrashOptions) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./nativeEffectCrashFixture.mjs', import.meta.url)), JSON.stringify(options)], {
    cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000
  })
  expect(result.error, result.stderr || result.stdout).toBeUndefined()
  expect(result.status, result.stderr || result.stdout).toBe(nativeEffectCrashExitCode)
}
function effects(options: NativeEffectCrashOptions) {
  const file = join(options.root, 'effects.log')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []
}
function journal(options: NativeEffectCrashOptions) {
  const sql = new Database(join(options.root, 'conversation.sqlite'))
  try { return sql.prepare('SELECT thread_id,run_id,call_id,tool_name,state,effect_attempt,confirmation_count,resources_value FROM execution_effects ORDER BY tool_name').all() as Array<{
    thread_id: string; run_id: string; call_id: string; tool_name: string; state: string; effect_attempt: number; confirmation_count: number; resources_value: Buffer
  }> } finally { sql.close() }
}
function fileResult(result: Awaited<ReturnType<typeof runNativeEffectCrashHarness>>, name: string): Record<string, unknown> {
  const message = result.history.find(message => message.kind === 'tool' && message.name === name)
  if (!message) throw new Error(`Missing ${name} result`)
  return JSON.parse(toolResultText(message)) as Record<string, unknown>
}
async function approveRecovery(options: NativeEffectCrashOptions, required: boolean) {
  let result = await runNativeEffectCrashHarness(options)
  if (required) {
    expect(result.phase).toBe('waiting'); expect(result.approvals).toHaveLength(1)
    const pending = result.approvals[0]
    expect(pending.request).toMatchObject({ actionRequests: [{ anasRecovery: { ordinal: 1, state: 'uncertain' } }] })
    result = await runNativeEffectCrashHarness({ ...options, decision: { id: pending.id, generation: pending.generation, type: 'approve' } })
  }
  expect(result.phase).toBe('completed'); expect(result.approvals).toEqual([])
  return result
}
async function fileHistory(options: NativeEffectCrashOptions) {
  const sql = new Database(join(options.root, 'conversation.sqlite'))
  try {
    const ledger = new FileChangeLedger(sql)
    const rows = sql.prepare('SELECT operation_id FROM agent_file_changes WHERE request_id=?').all(options.runId) as Array<{ operation_id: string }>
    return await Promise.all(rows.map(async row => ({ record: await ledger.load(options.runId, row.operation_id), events: ledger.events(options.runId, row.operation_id) })))
  } finally { sql.close() }
}
async function restoreFixture(existing: boolean) {
  const options = { ...fixture(), scenario: 'restore' as const }, workspace = join(options.root, 'workspace')
  mkdirSync(workspace)
  const target = join(workspace, 'target.txt'), before = 'restore before\n'
  if (existing) writeFileSync(target, before)
  const files = new FileEditStore(join(options.root, 'file-edits'))
  const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [
    existing ? { type: 'update', path: target, patch: '@@\n-restore before\n+restore after\n' }
      : { type: 'create', path: target, content: 'restore after\n' },
    { type: 'create', path: 'second.txt', content: 'second\n' }
  ] }), workspace)
  const source = await files.executePatch(resolved.input, await captureFilePatchPreimages(resolved.targets), randomUUID(), { operationId: randomUUID() })
  return { options: { ...options, restore: { requestId: source.requestId, operationId: source.operationId } }, source, files, target, before }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) })

describe('native effect recovery after real process exit', () => {
  it.each([true, false])('resumes a partial inverse for an existing=%s source as one native operation', async existing => {
    const { options, source, files, target, before } = await restoreFixture(existing)
    crash({ ...options, fault: 'patch_after_partial' })
    const [inverse] = await files.listEditRecordsForRequest(options.runId)
    expect(inverse.transaction.restores).toMatchObject({ operationId: source.operationId, requestId: source.requestId })
    expect((await files.loadOperationRecord(source.operationId, source.requestId)).transaction.reverseAttempt?.operationId).toBe(inverse.operationId)
    const result = await approveRecovery(options, true)
    expect(fileResult(result, 'restore_file_edit')).toMatchObject({ ok: true, operationId: inverse.operationId })
    if (existing) expect(readFileSync(target, 'utf8')).toBe(before)
    else expect(existsSync(target)).toBe(false)
    expect(existsSync(join(options.root, 'workspace', 'second.txt'))).toBe(false)
    expect(result.pendingFileCleanup).toEqual([])
    expect(await files.listEditRecordsForRequest(options.runId)).toEqual([])
    expect(await files.listEditRecordsForRequest(source.requestId)).toEqual([])
    const archived = await fileHistory(options)
    expect(archived).toHaveLength(1)
    expect(archived[0].record).toMatchObject({ operationId: inverse.operationId, transaction: { state: 'resolved', sourceFinalized: true,
      restores: { operationId: source.operationId, requestId: source.requestId } } })
    expect(archived[0].record?.transaction.entries[0].after?.text).toBe(existing ? before : null)
  }, 45_000)

  it('keeps both sides of an unfinished inverse when its interrupted run is cancelled', async () => {
    const { options, source, files, target } = await restoreFixture(true)
    crash({ ...options, fault: 'patch_after_partial' })
    const [inverse] = await files.listEditRecordsForRequest(options.runId)
    const paths = [target, join(options.root, 'workspace', 'second.txt')]
    const contents = () => paths.map(path => existsSync(path) ? readFileSync(path, 'utf8') : null)
    const before = contents()
    const result = await runNativeEffectCrashHarness({ ...options, cancel: true })
    expect(result.phase).toBe('cancelled'); expect(contents()).toEqual(before)
    expect(result.pendingFileCleanup).toEqual([])
    expect(await files.listEditRecordsForRequest(options.runId)).toMatchObject([{ operationId: inverse.operationId, transaction: { state: 'retained' } }])
    expect(await files.listEditRecordsForRequest(source.requestId)).toMatchObject([{ operationId: source.operationId, transaction: { reverseAttempt: { operationId: inverse.operationId } } }])
    expect((await files.loadOperationRecord(source.operationId, source.requestId)).transaction.recovery).toBeUndefined()
    expect(journal(options)[0]).toMatchObject({ state: 'intent', effect_attempt: 1, confirmation_count: 0 })
    expect((await runNativeEffectCrashHarness(options)).phase).toBe('cancelled')
    expect(contents()).toEqual(before)
  }, 45_000)

  it.each([false, true])('preserves finalized restore evidence and later edits with cancellation=%s', async cancel => {
    const { options, source, files, target, before } = await restoreFixture(true)
    crash({ ...options, fault: 'patch_after_finalized' })
    expect((await files.loadOperationRecord(source.operationId, source.requestId)).transaction.recovery?.state).toBe('complete')
    const [inverse] = await files.listEditRecordsForRequest(options.runId)
    expect(readFileSync(target, 'utf8')).toBe(before)
    if (!cancel) writeFileSync(target, 'later user change')
    const result = cancel ? await runNativeEffectCrashHarness({ ...options, cancel }) : await approveRecovery(options, true)
    expect(result.phase).toBe(cancel ? 'cancelled' : 'completed')
    if (!cancel) expect(fileResult(result, 'restore_file_edit')).toMatchObject({ ok: true, operationId: inverse.operationId })
    expect(readFileSync(target, 'utf8')).toBe(cancel ? before : 'later user change')
    expect(result.pendingFileCleanup).toEqual([])
    expect(await files.listEditRecordsForRequest(options.runId)).toEqual([])
    expect(await files.listEditRecordsForRequest(source.requestId)).toEqual([])
    expect((await fileHistory(options))[0].record).toMatchObject({ operationId: inverse.operationId, transaction: { sourceFinalized: true } })
    expect((await runNativeEffectCrashHarness(options)).phase).toBe(result.phase)
    expect(readFileSync(target, 'utf8')).toBe(cancel ? before : 'later user change')
  }, 45_000)

  it.each(['patch_before_metadata', 'patch_after_applied', 'after_result'] as const)('recovers write_file after %s without replacing the applied file', async fault => {
    const options = { ...fixture(), scenario: 'write-file' as const }
    crash({ ...options, fault })
    const target = join(options.root, 'workspace', 'target.txt'), inode = statSync(target).ino
    const files = new FileEditStore(join(options.root, 'file-edits'))
    const original = fault === 'patch_before_metadata' ? undefined : (await files.listEditRecordsForRequest(options.runId))[0]
    const result = await approveRecovery(options, fault === 'patch_after_applied')
    expect(fileResult(result, 'write_file')).toMatchObject({ ok: true, ...(original ? { operationId: original.operationId } : {}) })
    expect(readFileSync(target, 'utf8')).toBe('write after\n')
    if (original) expect(statSync(target).ino).toBe(inode)
    expect(await files.listEditRecordsForRequest(options.runId)).toEqual([])
    const archived = await fileHistory(options)
    expect(archived).toHaveLength(1)
    expect(archived[0].record?.transaction.entries).toMatchObject([{ before: { text: 'write before\n' }, after: { text: 'write after\n' } }])
  }, 45_000)

  it('restarts unpublished patch preparation only while its effect is unarmed', async () => {
    const options = { ...fixture(), scenario: 'patch' as const }
    crash({ ...options, fault: 'patch_before_metadata' })
    const files = new FileEditStore(join(options.root, 'file-edits'))
    expect(readFileSync(join(options.root, 'workspace', 'target.txt'), 'utf8')).toBe('write before\n')
    expect(journal(options)).toMatchObject([{ state: 'prepared', effect_attempt: 0 }])
    expect(await files.listRetainedEditRecords()).toMatchObject([{ tool: 'unavailable', requestId: options.runId }])
    expect(fileResult(await approveRecovery(options, false), 'apply_patch')).toMatchObject({ ok: true })
    expect(readFileSync(join(options.root, 'workspace', 'target.txt'), 'utf8')).toBe('write after\n')
    expect(readFileSync(join(options.root, 'workspace', 'second.txt'), 'utf8')).toBe('second\n')
    expect(await files.listEditRecordsForRequest(options.runId)).toEqual([])
    const archived = await fileHistory(options)
    expect(archived).toHaveLength(1)
    expect(archived[0].record?.transaction.entries).toMatchObject([
      { before: { text: 'write before\n' }, after: { text: 'write after\n' } }, { after: { text: 'second\n' } }
    ])
  }, 45_000)

  it.each(['patch_before_postimage', 'patch_after_partial', 'patch_after_applied', 'patch_before_history', 'patch_after_history', 'after_result', 'after_accept'] as const)(
    'recovers a real native patch batch after %s with stable recovery material', async fault => {
      const options = { ...fixture(), scenario: 'patch' as const }
      crash({ ...options, fault })
      const files = new FileEditStore(join(options.root, 'file-edits')), target = join(options.root, 'workspace', 'target.txt')
      const [record] = await files.listEditRecordsForRequest(options.runId)
      const original = join(files.editRecordDir(options.runId, record.operationId), '0.before.txt')
      expect(readFileSync(original, 'utf8')).toBe('write before\n')
      const inode = statSync(target).ino, before = journal(options)[0]
      const result = await approveRecovery(options, fault !== 'after_result' && fault !== 'after_accept')
      expect(fileResult(result, 'apply_patch')).toMatchObject({ operationId: record.operationId, ok: fault !== 'patch_before_postimage' })
      expect(readFileSync(target, 'utf8')).toBe('write after\n'); expect(statSync(target).ino).toBe(inode)
      if (fault !== 'patch_before_postimage') expect(readFileSync(join(options.root, 'workspace', 'second.txt'), 'utf8')).toBe('second\n')
      else expect(existsSync(join(options.root, 'workspace', 'second.txt'))).toBe(false)
      if (fault === 'patch_before_postimage') {
        expect(readFileSync(original, 'utf8')).toBe('write before\n')
        expect(await files.listEditRecordsForRequest(options.runId)).toHaveLength(1)
      } else expect(await files.listEditRecordsForRequest(options.runId)).toEqual([])
      const archived = await fileHistory(options)
      expect(archived).toHaveLength(1)
      expect(archived[0].record?.operationId).toBe(record.operationId)
      expect(archived[0].record?.transaction.entries[0].before.text).toBe('write before\n')
      if (fault !== 'patch_before_postimage') expect(archived[0].record?.transaction.entries.map(entry => entry.after?.text)).toEqual(['write after\n', 'second\n'])
      expect(journal(options)[0]).toMatchObject({ call_id: before.call_id, resources_value: before.resources_value, state: 'result' })
      if (fault === 'patch_before_history' || fault === 'patch_after_history') {
        const confirmed = archived[0].events.filter(event => event.phase === 'applied')
        expect(confirmed).toHaveLength(2); expect(confirmed[0].observed).toBe(fault === 'patch_before_history' ? 1 : 0)
      }
    }, 45_000)

  it('does not recreate missing patch metadata after the effect was armed', async () => {
    const options = { ...fixture(), scenario: 'patch' as const }
    crash({ ...options, fault: 'patch_after_partial' })
    const files = new FileEditStore(join(options.root, 'file-edits')), [record] = await files.listEditRecordsForRequest(options.runId)
    const directory = files.editRecordDir(record.requestId, record.operationId)
    rmSync(join(directory, 'record.json'))
    expect(fileResult(await approveRecovery(options, true), 'apply_patch')).toMatchObject({ ok: false })
    expect(readFileSync(join(options.root, 'workspace', 'target.txt'), 'utf8')).toBe('write after\n')
    expect(existsSync(join(options.root, 'workspace', 'second.txt'))).toBe(false)
    expect(readFileSync(join(directory, '0.before.txt'), 'utf8')).toBe('write before\n')
    expect(existsSync(join(directory, 'record.json'))).toBe(false)
  }, 45_000)

  it('recovers a child effect under its saved child identity without dispatching the parent', async () => {
    const options = { ...fixture(), child: { id: randomUUID(), threadId: randomUUID(), runId: randomUUID() } }
    crash({ ...options, fault: 'after_effect' })
    const before = journal(options)
    expect(before).toEqual([expect.objectContaining({ thread_id: options.child.threadId, run_id: options.child.runId,
      state: 'intent', effect_attempt: 1, confirmation_count: 0 })])
    expect(effects(options)).toEqual(['child'])
    const waiting = await runNativeEffectCrashHarness(options)
    expect(waiting.phase).toBe('waiting'); expect(waiting.approvals).toHaveLength(1)
    expect(waiting.parent).toMatchObject({ phase: 'prepare_model', call: { id: options.child.id, status: 'interrupted',
      ownerThreadId: options.threadId, parentRunId: options.runId, childThreadId: options.child.threadId, childRunId: options.child.runId } })
    expect(waiting.parent?.history).toEqual([expect.objectContaining({ kind: 'user', content: 'Run the isolated effect' })])
    expect(effects(options)).toEqual(['child'])
    const pending = waiting.approvals[0]
    expect(pending.request).toMatchObject({ actionRequests: [{ anasRecovery: { ordinal: 1, state: 'uncertain' } }] })
    const final = await runNativeEffectCrashHarness({ ...options, decision: { id: pending.id, generation: pending.generation, type: 'reject' } })
    expect(final.phase).toBe('completed'); expect(final.approvals).toEqual([])
    expect(final.parent).toMatchObject({ phase: 'prepare_model', call: { status: 'completed', result: 'Done' } })
    expect(final.parent?.history).toEqual(waiting.parent?.history)
    expect(final.history.find(message => message.kind === 'tool')?.resultStatus).toBe('error')
    expect(journal(options)).toEqual([expect.objectContaining({ ...before[0], state: 'result', confirmation_count: 1 })])
    expect(effects(options)).toEqual(['child'])
    expect((await runNativeEffectCrashHarness(options)).parent).toEqual(final.parent)
    expect(effects(options)).toEqual(['child'])
  }, 45_000)

  it.each(['parallel', 'parallel-result'] as const)('recovers independent siblings after a %s hard crash', async scenario => {
    const options = { ...fixture(), scenario }
    const mixed = scenario === 'parallel-result'
    crash({ ...options, fault: mixed ? 'after_arm' : 'after_effect' })
    expect(effects(options)).toEqual(['left'])
    const before = journal(options)
    expect(before.find(row => row.tool_name === 'mcp_left')).toMatchObject({ state: mixed ? 'result' : 'intent', effect_attempt: 1, confirmation_count: 0 })
    if (mixed) {
      expect(before.find(row => row.tool_name === 'mcp_right')).toMatchObject({ state: 'intent', effect_attempt: 1, confirmation_count: 0 })
      const sql = new Database(join(options.root, 'conversation.sqlite'))
      try { expect(sql.prepare('SELECT result_record_id FROM execution_calls').all()).toEqual([
        { result_record_id: null }, { result_record_id: null }
      ]) } finally { sql.close() }
    }
    const waiting = await runNativeEffectCrashHarness(options)
    expect(waiting.phase).toBe('waiting'); expect(waiting.approvals).toHaveLength(1)
    const pending = waiting.approvals[0]
    expect(pending.request).toMatchObject({ actionRequests: [{ name: mixed ? 'mcp_right' : 'mcp_left', anasRecovery: { ordinal: 1, state: 'uncertain' } }] })
    expect(effects(options)).toEqual(mixed ? ['left'] : ['left', 'right'])
    expect(journal(options)).toMatchObject([
      { tool_name: 'mcp_left', state: mixed ? 'result' : 'intent' },
      { tool_name: 'mcp_right', state: mixed ? 'intent' : 'result' }
    ])
    const final = await runNativeEffectCrashHarness({ ...options, decision: { id: pending.id, generation: pending.generation, type: mixed ? 'reject' : 'approve' } })
    expect(final.phase).toBe('completed'); expect(final.approvals).toEqual([])
    expect(effects(options)).toEqual(mixed ? ['left'] : ['left', 'right', 'left'])
    const results = final.history.filter(message => message.kind === 'tool')
    expect(results).toHaveLength(2)
    expect(results.find(message => message.name === 'mcp_left')).toMatchObject({ content: 'Effect completed', resultStatus: 'success', artifact: { bytes: new Uint8Array([1, 2]) } })
    expect(results.find(message => message.name === 'mcp_right')?.resultStatus).toBe(mixed ? 'error' : 'success')
    const after = journal(options)
    expect(after).toMatchObject([
      { state: 'result', effect_attempt: mixed ? 1 : 2, confirmation_count: mixed ? 0 : 1 },
      { state: 'result', effect_attempt: 1, confirmation_count: mixed ? 1 : 0 }
    ])
    for (const row of before) expect(after.find(candidate => candidate.call_id === row.call_id)?.resources_value).toEqual(row.resources_value)
    const finalEffects = effects(options)
    expect((await runNativeEffectCrashHarness(options)).phase).toBe('completed')
    expect(effects(options)).toEqual(finalEffects)
  }, 45_000)

  it('keeps file access approval separate from uncertainty after a real deletion crashes', async () => {
    const options = { ...fixture(), scenario: 'host-file' as const }
    const ordinary = (await runNativeEffectCrashHarness(options)).approvals[0]
    expect(ordinary.request).toMatchObject({ actionRequests: [{ name: 'delete_file' }] })
    expect(ordinary.request).not.toMatchObject({ actionRequests: [{ anasRecovery: expect.anything() }] })
    expect(existsSync(join(options.root, 'outside.txt'))).toBe(true)
    expect(journal(options)).toEqual([]); expect(effects(options)).toEqual([])
    const decision = { id: ordinary.id, generation: ordinary.generation, type: 'approve' as const }
    crash({ ...options, decision, fault: 'after_effect' })
    expect(existsSync(join(options.root, 'outside.txt'))).toBe(false)
    expect(effects(options)).toEqual(['host-file'])
    const recovery = (await runNativeEffectCrashHarness(options)).approvals[0]
    expect(recovery.id).not.toBe(ordinary.id)
    expect(recovery.request).toMatchObject({ actionRequests: [{ name: 'delete_file', anasRecovery: { ordinal: 1, state: 'uncertain' } }] })
    await expect(runNativeEffectCrashHarness({ ...options, decision })).rejects.toThrow()
    expect(journal(options)[0]).toMatchObject({ state: 'intent', effect_attempt: 1, confirmation_count: 0 })
    const final = await runNativeEffectCrashHarness({ ...options, decision: { id: recovery.id, generation: recovery.generation, type: 'reject' } })
    expect(final.phase).toBe('completed'); expect(effects(options)).toEqual(['host-file'])
    expect(existsSync(join(options.root, 'outside.txt'))).toBe(false)
  }, 45_000)

  it('keeps a committed rejection after a hard crash without asking or executing again', async () => {
    const options = fixture(); crash({ ...options, fault: 'after_effect' })
    const approval = (await runNativeEffectCrashHarness(options)).approvals[0]
    crash({ ...options, fault: 'after_decision', decision: { id: approval.id, generation: approval.generation, type: 'reject' } })
    expect(journal(options)[0]).toMatchObject({ state: 'result', effect_attempt: 1, confirmation_count: 1 })
    const final = await runNativeEffectCrashHarness(options)
    expect(final.phase).toBe('completed'); expect(final.approvals).toEqual([])
    expect(final.history.find(message => message.kind === 'tool')?.resultStatus).toBe('error')
    expect(effects(options)).toEqual(['single'])
  }, 45_000)

  it('requires a fresh approval after an approved attempt also crashes', async () => {
    const options = fixture(); crash({ ...options, fault: 'after_effect' })
    const first = (await runNativeEffectCrashHarness(options)).approvals[0]
    expect(effects(options)).toEqual(['single'])
    const decision = { id: first.id, generation: first.generation, type: 'approve' as const }
    crash({ ...options, fault: 'after_effect', decision })
    expect(effects(options)).toEqual(['single', 'single'])
    expect(journal(options)[0]).toMatchObject({ state: 'intent', effect_attempt: 2, confirmation_count: 1 })
    const second = (await runNativeEffectCrashHarness(options)).approvals[0]
    expect(second.generation).not.toBe(first.generation)
    expect(second.request).toMatchObject({ actionRequests: [{ anasRecovery: { ordinal: 2, state: 'uncertain' } }] })
    await expect(runNativeEffectCrashHarness({ ...options, decision })).rejects.toThrow()
    expect(effects(options)).toEqual(['single', 'single'])
    expect(journal(options)[0].confirmation_count).toBe(1)
    const final = await runNativeEffectCrashHarness({ ...options, decision: { id: second.id, generation: second.generation, type: 'reject' } })
    expect(final.phase).toBe('completed'); expect(effects(options)).toEqual(['single', 'single'])
    expect(journal(options)[0]).toMatchObject({ state: 'result', effect_attempt: 2, confirmation_count: 2 })
  }, 60_000)

  it.each([
    { fault: 'before_prepare' as const, effects: 0, state: undefined, uncertain: false },
    { fault: 'after_prepare' as const, effects: 0, state: 'prepared', uncertain: false },
    { fault: 'after_arm' as const, effects: 0, state: 'intent', uncertain: true },
    { fault: 'after_effect' as const, effects: 1, state: 'intent', uncertain: true },
    { fault: 'after_result' as const, effects: 1, state: 'result', uncertain: false },
    { fault: 'after_accept' as const, effects: 1, state: 'result', uncertain: false }
  ])('recovers $fault without an unapproved duplicate effect', async boundary => {
    const options = fixture(); crash({ ...options, fault: boundary.fault })
    expect(effects(options)).toHaveLength(boundary.effects)
    const before = journal(options)
    if (boundary.state) expect(before).toEqual([expect.objectContaining({ state: boundary.state, confirmation_count: 0,
      effect_attempt: boundary.state === 'prepared' ? 0 : 1 })])
    else expect(before).toEqual([])
    let recovered = await runNativeEffectCrashHarness(options)
    if (boundary.uncertain) {
      expect(recovered.phase).toBe('waiting'); expect(recovered.approvals).toHaveLength(1)
      expect(recovered.approvals[0].request).toMatchObject({ actionRequests: [{ anasRecovery: { ordinal: 1, state: 'uncertain' } }] })
      expect(effects(options)).toHaveLength(boundary.effects)
      const approval = recovered.approvals[0]
      recovered = await runNativeEffectCrashHarness({ ...options, decision: { id: approval.id, generation: approval.generation, type: 'reject' } })
      expect(effects(options)).toHaveLength(boundary.effects)
      expect(recovered.history.find(message => message.kind === 'tool')?.resultStatus).toBe('error')
    } else {
      expect(effects(options)).toEqual(['single'])
      expect(recovered.history.find(message => message.kind === 'tool')).toMatchObject({ content: 'Effect completed', artifact: { bytes: new Uint8Array([1, 2]) } })
    }
    expect(recovered.phase).toBe('completed'); expect(recovered.approvals).toEqual([])
    const after = journal(options)
    expect(after).toEqual([expect.objectContaining({ state: 'result' })])
    if (before.length) { expect(after[0].call_id).toBe(before[0].call_id); expect(after[0].resources_value).toEqual(before[0].resources_value) }
    const trace = readFileSync(join(options.root, 'trace.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { callId: string })
    expect(new Set(trace.map(event => event.callId)).size).toBe(1)
    const finalEffects = effects(options)
    expect((await runNativeEffectCrashHarness(options)).phase).toBe('completed')
    expect(effects(options)).toEqual(finalEffects)
  }, 45_000)
})
