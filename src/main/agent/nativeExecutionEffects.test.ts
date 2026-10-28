import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { executeJournaledTool, type ToolEffectExecution, type ToolEffectRecoveryRequest } from '../../runtime/toolEffects'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import type { ExecutionEffectRecord, ExecutionMessageInput, ExecutionToolCall } from '../../runtime/executionState'
import { NativeExecutionStore, nativeExecutionSchema } from './nativeExecutionStore'

const roots: string[] = [], databases: Database.Database[] = []
const key = { threadId: 'thread', runId: 'run', callId: 'call' }
const context = { modelCalls: 0, todos: [] }
const boundary = { kind: 'file_write', target: { path: '/fixture', content: 'value' } }
const result = (text = 'done'): ExecutionMessageInput => ({ id: 'result', value: {
  kind: 'tool', resultFor: 'provider-call', content: text, artifact: { bytes: new Uint8Array([0, 255]) }
} })
function open(file: string, initialize = false) {
  const database = new Database(file)
  database.pragma('foreign_keys = ON')
  if (initialize) database.exec(nativeExecutionSchema)
  databases.push(database)
  return database
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'anas-native-effects-'))
  roots.push(root)
  const file = join(root, 'state.sqlite'), database = open(file, true), store = new NativeExecutionStore(database)
  const call: ExecutionToolCall = { id: 'call', providerCallId: 'provider-call', name: 'write', args: { path: '/fixture' },
    artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, `resource:${purpose}`])) as ExecutionToolCall['artifacts'] }
  store.start({ threadId: 'thread', runId: 'run', messages: [{ id: 'input', value: { kind: 'user', content: 'write' } }], context })
  store.acceptModel(scope(store), { id: 'response', value: { kind: 'assistant', content: '', calls: [{ id: 'provider-call', name: 'write', args: call.args }] } },
    [call], { ...context, modelCalls: 1 })
  store.prepareTools(scope(store), [{ callId: 'call', args: call.args }])
  store.prepareEffect(key, 'confirm')
  return { file, database, store }
}
function scope(store: NativeExecutionStore) {
  return { threadId: 'thread', runId: 'run', expectedRevisionId: store.load('thread')!.revisionId }
}
class Waiting extends Error {}
function execute(store: NativeExecutionStore, invoke: ToolEffectExecution<ExecutionEffectRecord, ExecutionMessageInput>['invoke']) {
  return executeJournaledTool<ExecutionEffectRecord, ExecutionMessageInput>({
    initial: store.loadEffect(key)!, invoke, arm: effect => store.armEffect(key, effect),
    retry: retry => store.retryEffect(key, retry), load: () => store.loadEffect(key),
    restore: async row => row.result!, save: async (value, confirmation) => store.saveEffectResult(key, value, confirmation),
    cleanup() {}, recoverManaged: async () => undefined, isInterruption: error => error instanceof Waiting,
    errorResult: message => result(message), requestRecovery: async request => {
      const generation = `generation-${request.actionRequests[0].anasRecovery.ordinal}`
      store.wait(scope(store), [{ id: 'approval', generation, kind: 'effect_recovery', callIds: ['call'], request }])
      throw new Waiting('awaiting confirmation')
    }
  })
}
afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('native durable tool effects', () => {
  it('restores a durable result after reopen even when the batch never received it', async () => {
    const first = fixture()
    let calls = 0
    const saved = await execute(first.store, async attempt => { attempt.arm(boundary); calls++; return result() })
    expect(first.store.load('thread')!.calls[0].result).toBeUndefined()
    first.database.close()
    const store = new NativeExecutionStore(open(first.file))
    const restored = await execute(store, async () => { calls++; throw new Error('must not replay') })
    expect({ id: restored.id, value: restored.value }).toEqual(saved)
    expect(restored).toHaveProperty('recordId', store.loadEffect(key)!.result!.recordId)
    expect(calls).toBe(1)
    store.settleCall(scope(store), 'call', restored)
    store.finishBatch(scope(store))
    expect(store.load('thread')!.messages.at(-1)?.value.artifact).toEqual({ bytes: new Uint8Array([0, 255]) })
    expect(store.loadEffect(key)!.result!.value).toEqual(saved.value)
    expect(store.loadEffect({ ...key, threadId: 'other' })).toBeUndefined()
  })

  it('requires a new approval after each uncertain attempt and never applies an old answer again', async () => {
    const first = fixture()
    first.store.armEffect(key, boundary)
    first.database.close()
    const store = new NativeExecutionStore(open(first.file))
    let calls = 0
    const invoke = async (attempt: Parameters<Parameters<typeof execute>[1]>[0]) => {
      attempt.arm(boundary); calls++; throw new Error('external result lost')
    }
    await expect(execute(store, invoke)).rejects.toThrow('awaiting confirmation')
    expect(calls).toBe(0)
    expect(store.loadEffect(key)).toMatchObject({ state: 'intent', effectAttempt: 1, confirmationCount: 0 })
    store.resolveWait(scope(store), { approval: 'generation-1' }, () => {
      store.retryEffect(key, { kind: 'approved', expectedConfirmationCount: 0 })
    })
    await expect(execute(store, invoke)).rejects.toThrow('awaiting confirmation')
    expect(calls).toBe(1)
    expect(store.loadEffect(key)).toMatchObject({ state: 'intent', effectAttempt: 2, confirmationCount: 1 })
    expect((store.load('thread')!.approvals[0].request as ToolEffectRecoveryRequest).actionRequests[0].anasRecovery.ordinal).toBe(2)
    expect(() => store.resolveWait(scope(store), { approval: 'generation-1' }, () => {
      throw new Error('must not apply')
    })).toThrow('generation changed')
    expect(() => store.retryEffect(key, { kind: 'approved', expectedConfirmationCount: 0 })).toThrow('ordinal or mode changed')
  })

  it('rolls approval consumption and its effect retry back as one transaction', async () => {
    const { store } = fixture()
    store.armEffect(key, boundary)
    await expect(execute(store, async () => result())).rejects.toThrow('awaiting confirmation')
    const before = store.load('thread')
    expect(() => store.resolveWait(scope(store), { approval: 'generation-1' }, () => {
      store.retryEffect(key, { kind: 'approved', expectedConfirmationCount: 0 })
      throw new Error('receipt commit failed')
    })).toThrow('receipt commit failed')
    expect(store.load('thread')).toEqual(before)
    expect(store.loadEffect(key)).toMatchObject({ state: 'intent', confirmationCount: 0 })
  })

  it('preserves effect boundaries and completed results across attempted changes', () => {
    const { store } = fixture()
    store.prepareEffect(key, 'idempotent')
    store.armEffect(key, { ...boundary, idempotencyFingerprint: 'a'.repeat(64) })
    expect(() => store.retryEffect(key, { kind: 'approved', expectedConfirmationCount: 0 })).toThrow('ordinal or mode changed')
    store.retryEffect(key, { kind: 'automatic', expectedAutomaticRetryCount: 0 })
    expect(() => store.armEffect(key, { ...boundary, target: { path: '/different' } })).toThrow('different effect boundary')
    store.armEffect(key, { ...boundary, idempotencyFingerprint: 'a'.repeat(64) })
    const saved = store.saveEffectResult(key, result())
    expect(store.saveEffectResult(key, result())).toEqual(saved)
    expect(() => store.saveEffectResult(key, result('different'))).toThrow('cannot be replaced')
    expect(() => store.saveEffectResult(key, { id: 'wrong', value: { kind: 'tool', resultFor: 'other', content: '' } })).toThrow('must answer')
  })

  it('allows only the registered detached owner to arm during a pending decision', () => {
    const { database, store } = fixture()
    store.wait(scope(store), [{ id: 'approval', generation: 'generation', kind: 'tool', callIds: ['call'], request: {
      actionRequests: [{ name: 'write', args: {}, description: '' }], reviewConfigs: [{ actionName: 'write', allowedDecisions: ['approve', 'reject'] }]
    } }])
    expect(() => store.armEffect(key, boundary)).toThrow('Only an owned detached call')
    const owner = new NativeExecutionStore(database, undefined, effect => effect.artifacts['managed-call'] === 'resource:managed-call')
    owner.armEffect(key, boundary)
    expect(owner.loadEffect(key)!.state).toBe('intent')
    owner.finish(scope(owner), 'cancelled')
    expect(() => owner.saveEffectResult(key, result())).toThrow('no longer active')
    expect(owner.loadEffect(key)!.state).toBe('intent')
  })
  it('prepares one owned immutable call idempotently and discards only never-armed effects', () => {
    const { database, store } = fixture(), original = store.loadEffect(key)!
    expect(original).toMatchObject({ state: 'prepared', effectAttempt: 0, confirmationCount: 0, automaticRetryCount: 0, toolName: 'write', providerCallId: 'provider-call' })
    expect(store.prepareEffect(key, 'confirm')).toEqual(original)
    expect(store.prepareEffect(key, 'idempotent')).toMatchObject({ recoveryMode: 'idempotent', state: 'prepared' })
    expect(store.prepareEffect(key, 'confirm')).toEqual(original)
    const copied = store.load('thread')!.calls[0]; copied.args = { path: '/different' }
    expect(store.prepareEffect(key, 'confirm')).toEqual(original)
    database.prepare('UPDATE execution_effects SET args_json=? WHERE call_id=?').run('{"path":"/different"}', key.callId)
    expect(() => store.prepareEffect(key, 'confirm')).toThrow('immutable call identity')
    database.prepare('UPDATE execution_effects SET args_json=? WHERE call_id=?').run(original.argsJson, key.callId)
    expect(() => store.prepareEffect({ ...key, threadId: 'foreign' }, 'confirm')).toThrow()
    expect(() => store.prepareEffect({ ...key, runId: 'foreign' }, 'confirm')).toThrow()
    expect(store.discardUnarmedEffect(key)).toBe(true); expect(store.loadEffect(key)).toBeUndefined()
    expect(store.discardUnarmedEffect(key)).toBe(false)
    store.prepareEffect(key, 'confirm'); store.armEffect(key, boundary)
    expect(() => store.discardUnarmedEffect(key)).toThrow('cannot be discarded after its boundary')
  })

  it.each(['automatic', 'approved'] as const)('counts %s retry decisions separately from actual effect attempts', kind => {
    const { store } = fixture(), automatic = kind === 'automatic'
    const arm = { kind: automatic ? 'http_mutation' : 'shell_process', target: automatic ? { method: 'POST', url: 'https://example.test/10' } : { command: 'deploy' },
      ...(automatic ? { recoveryMode: 'idempotent' as const, idempotencyFingerprint: 'a'.repeat(64) } : {}) }
    expect(store.armEffect(key, arm)).toMatchObject({ state: 'intent', effectAttempt: 1, confirmationCount: 0, automaticRetryCount: 0 })
    expect(() => store.armEffect(key, arm)).toThrow('Cannot arm an effect from intent')
    const retry = automatic ? { kind: 'automatic' as const, expectedAutomaticRetryCount: 0 } : { kind: 'approved' as const, expectedConfirmationCount: 0 }
    expect(store.retryEffect(key, retry)).toMatchObject({ state: 'prepared', effectAttempt: 1, confirmationCount: automatic ? 0 : 1, automaticRetryCount: automatic ? 1 : 0 })
    expect(() => store.armEffect(key, { ...arm, target: { changed: true } })).toThrow('different effect boundary')
    expect(store.armEffect(key, arm)).toMatchObject({ state: 'intent', effectAttempt: 2 })
    expect(() => store.retryEffect(key, retry)).toThrow('ordinal or mode changed')
    if (automatic) {
      const saved = store.saveEffectResult(key, result())
      expect(saved).toMatchObject({ state: 'result', effectAttempt: 2, automaticRetryCount: 1 })
      expect(store.saveEffectResult(key, result())).toEqual(saved)
    } else {
      expect(store.retryEffect(key, { kind: 'approved', expectedConfirmationCount: 1 })).toMatchObject({ state: 'prepared', effectAttempt: 2, confirmationCount: 2 })
      const rejected = { ...result('Recovery rejected.'), value: { ...result('Recovery rejected.').value, resultStatus: 'error' as const, resultMetadata: { recovery: 'rejected' } } }
      const saved = store.saveEffectResult(key, rejected, { kind: 'rejected', expectedConfirmationCount: 2 })
      expect(saved).toMatchObject({ state: 'result', effectAttempt: 2, confirmationCount: 3 })
      expect(store.saveEffectResult(key, rejected, { kind: 'rejected', expectedConfirmationCount: 2 })).toEqual(saved)
    }
    expect(() => store.armEffect(key, arm)).toThrow('Cannot arm an effect from result')
  })

  it('saves a confirmed no-op result without claiming the effect boundary was crossed', () => {
    const { store } = fixture()
    expect(store.saveEffectResult(key, result())).toMatchObject({ state: 'result', effectAttempt: 0, confirmationCount: 0, automaticRetryCount: 0 })
  })
})
