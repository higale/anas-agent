import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeConversationMessage } from '../../runtime/conversationStorage'
import { encodeExecutionValue } from '../../runtime/executionValue'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import { authorizationInputHash } from '../../runtime/authorizationReceipts'
import type { ExecutionApproval, ExecutionContext, ExecutionToolCall, ExecutionMessageInput } from '../../runtime/executionState'
import { NativeExecutionStore, nativeExecutionSchema } from './nativeExecutionStore'

const databases: Database.Database[] = [], roots: string[] = []
function database(file = ':memory:', initialize = true) {
  const result = new Database(file)
  result.pragma('foreign_keys = ON')
  if (initialize) result.exec(nativeExecutionSchema)
  databases.push(result)
  return result
}
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const context = (): ExecutionContext => ({ modelCalls: 0, todos: [] })
const input = (id: string, text: string): ExecutionMessageInput => ({ id, value: { kind: 'user', content: text } })
const result = (id: string, text: string): ExecutionMessageInput => ({ id, value: { kind: 'tool', resultFor: 'provider-repeated-id', content: text } })
function call(id: string): ExecutionToolCall {
  return { id, providerCallId: 'provider-repeated-id', name: 'fixture', args: { enabled: false, limit: 0 },
    artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, `${id}:${purpose}`])) as ExecutionToolCall['artifacts'] }
}
function scope(store: NativeExecutionStore) {
  const state = store.load('thread')!
  return { threadId: state.threadId, runId: state.runId, expectedRevisionId: state.revisionId }
}
function begin(store: NativeExecutionStore) {
  store.start({ threadId: 'thread', runId: 'run', messages: [input('input', 'Run tools')], context: context() })
}
function batch(store: NativeExecutionStore) {
  const calls = [call('left'), call('right')]
  store.acceptModel(scope(store), { id: 'model', value: { kind: 'assistant', content: '',
    calls: calls.map(call => ({ id: call.providerCallId, name: call.name, args: call.args })) } }, calls, { ...context(), modelCalls: 1 })
}
function approval(): Extract<ExecutionApproval, { kind: 'tool' | 'effect_recovery' }> {
  return { id: 'approval', generation: 'generation-1', kind: 'effect_recovery', callIds: ['left'],
    request: { actionRequests: [{ name: 'fixture', args: {}, description: 'An earlier attempt may have completed.' }],
      reviewConfigs: [{ actionName: 'fixture', allowedDecisions: ['approve', 'reject'] }] } }
}

describe('native message snapshots and incremental bodies', () => {
  it('retains invalid numeric arguments across reopen without authorizing an effect', () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-native-invalid-number-')); roots.push(root)
    const file = join(root, 'state.sqlite'), first = database(file)
    const store = new NativeExecutionStore(first)
    begin(store)
    const requested = { ...call('invalid'), args: { extra: { values: [Infinity, -Infinity, NaN, -0] } } }
    store.acceptModel(scope(store), { id: 'model', value: { kind: 'assistant', content: '',
      calls: [{ id: requested.providerCallId, name: requested.name, args: requested.args }] } }, [requested], { ...context(), modelCalls: 1 })
    first.close()
    const reopened = new NativeExecutionStore(database(file, false)), state = reopened.load('thread')!
    expect(state.calls[0].args).toEqual(requested.args)
    expect(state.response!.value.calls![0].args).toEqual(requested.args)
    expect(() => reopened.prepareEffect({ threadId: 'thread', runId: 'run', callId: requested.id }, 'confirm')).toThrow()
    const other = new NativeExecutionStore(database()); begin(other)
    expect(() => other.acceptModel(scope(other), { id: 'model', value: { kind: 'assistant', content: '',
      calls: [{ id: requested.providerCallId, name: requested.name, args: { extra: { values: [null, null, null, 0] } } }] }
    }, [requested], { ...context(), modelCalls: 1 })).toThrow('complete model response')
  })

  it('keeps caller, observation and reloaded values independent of committed binary and nested data', () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-native-snapshots-')); roots.push(root)
    const file = join(root, 'state.sqlite'), first = database(file)
    const store = new NativeExecutionStore(first, commit => {
      for (const record of commit.messageRecords ?? []) {
        record.value.content = 'Mutated observer copy'
        if (record.value.artifact) (record.value.artifact as { bytes: Uint8Array }).bytes[0] = 99
      }
    })
    begin(store); batch(store)
    const original = { id: 'result', value: { kind: 'tool' as const, resultFor: 'provider-repeated-id', content: 'Saved result',
      artifact: { bytes: new Uint8Array([1, 2, 3]), values: new Map([['flags', new Set<false | number>([false, 0])]]) },
      source: { metadata: { nested: { flag: false } }, extras: {} } } }
    const expected = structuredClone(original)
    store.settleCall(scope(store), 'left', original)
    original.value.content = 'Mutated caller'
    original.value.artifact.bytes[1] = 99
    original.value.artifact.values.get('flags')!.clear()
    original.value.source.metadata.nested.flag = true
    const loaded = store.load('thread')!, retained = loaded.calls[0].result!
    expect(retained.value).toEqual(expected.value)
    const recordId = retained.recordId
    retained.value.content = 'Mutated read'
    ;(retained.value.artifact as { bytes: Uint8Array }).bytes[2] = 99
    loaded.context.todos.push({ content: 'Uncommitted', status: 'pending' })
    loaded.calls[0].args = { changed: true }
    first.close()
    const reopened = new NativeExecutionStore(database(file, false)), restored = reopened.load('thread')!
    expect(reopened.readMessageRecord('thread', recordId).value).toEqual(expected.value)
    expect(restored.calls[0].result!.value).toEqual(expected.value)
    expect(restored.calls[0].args).toEqual(call('left').args)
    expect(restored.context.todos).toEqual([])
    expect(restored.messages.map(message => message.value.content)).toEqual(['Run tools', ''])
  })

  it.each([1000, 10000])('writes only new bodies while retaining %i messages and large tool artifacts', size => {
    const db = database(), store = new NativeExecutionStore(db)
    const text = 'output '.repeat(200000), data = 'aGVsbG8='.repeat(200000)
    store.start({ threadId: 'thread', runId: 'run', context: context(), messages: [
      ...Array.from({ length: size }, (_, index) => input('input-' + index, 'Retained ' + index)),
      { id: 'large-text', value: { kind: 'tool', resultFor: 'text-call', content: text } },
      { id: 'large-image', value: { kind: 'tool', resultFor: 'image-call', content: 'image result', artifact: { content: [{ type: 'image', data, mimeType: 'image/png' }] } } }
    ] })
    // Observe physical body writes, including attempted rewrites, independently of JS object identity.
    db.exec(`CREATE TABLE observed_body_writes(bytes INTEGER NOT NULL);
      CREATE TRIGGER observe_body_insert BEFORE INSERT ON execution_message_bodies BEGIN INSERT INTO observed_body_writes VALUES(length(NEW.value)); END;
      CREATE TRIGGER observe_body_update BEFORE UPDATE ON execution_message_bodies BEGIN INSERT INTO observed_body_writes VALUES(length(NEW.value)); END;
      CREATE TRIGGER observe_body_delete BEFORE DELETE ON execution_message_bodies BEGIN INSERT INTO observed_body_writes VALUES(length(OLD.value)); END;`)
    const initial = store.load('thread')!, originalIds = initial.messages.map(record => record.recordId)
    for (let turn = 0; turn < 3; turn++) {
      store.acceptModel(scope(store), { id: 'answer-' + turn, value: { kind: 'assistant', content: 'Next answer' } }, [], { modelCalls: 1, todos: [] })
      store.finish(scope(store), 'completed')
      const head = store.load('thread')!
      store.start({ threadId: 'thread', runId: 'next-' + turn, expectedRevisionId: head.revisionId,
        messages: [input('next-input-' + turn, 'Next input')], context: context() })
    }
    const written = db.prepare('SELECT count(*) AS count,sum(bytes) AS bytes FROM observed_body_writes').get() as { count: number; bytes: number }
    expect(written.count).toBe(6)
    expect(written.bytes).toBeLessThan(2000)
    const history = store.readHistory('thread')!.messages
    expect(history.slice(0, originalIds.length).map(record => record.recordId)).toEqual(originalIds)
    expect(history[size].value.content).toBe(text)
    expect(history[size + 1].value.artifact).toEqual({ content: [{ type: 'image', data, mimeType: 'image/png' }] })
    expect(history).toHaveLength(size + 8)
  })
})

describe('native execution storage transactions', () => {
  it.each([null, [], 'wrong', 1, false].map(args => ({ args })))('retains raw input $args across reopen and requires a correction result before preparing it', ({ args }) => {
    const root = mkdtempSync(join(tmpdir(), 'anas-native-raw-input-')); roots.push(root)
    const file = join(root, 'state.sqlite'); let db = database(file), store = new NativeExecutionStore(db)
    begin(store)
    const requested = { ...call('invalid'), args }
    store.acceptModel(scope(store), { id: 'model', value: { kind: 'assistant', content: '',
      calls: [{ id: requested.providerCallId, name: requested.name, args }] } }, [requested], { ...context(), modelCalls: 1 })
    db.close(); db = database(file, false); store = new NativeExecutionStore(db)
    const original = store.load('thread')!
    expect(original.calls[0].args).toEqual(args)
    expect(original.response?.value.calls?.[0].args).toEqual(args)
    expect(() => store.prepareTools(scope(store), [{ callId: requested.id, args }])).toThrow('Prepared tool arguments')
    expect(store.load('thread')).toEqual(original)
    db.exec('UPDATE execution_calls SET prepared=1')
    expect(() => store.load('thread')).toThrow('Prepared tool arguments')
    db.exec('UPDATE execution_calls SET prepared=0')
    const correction = result('invalid-result', 'Tool arguments must be a JSON object. Correct the arguments and try again.')
    correction.value.resultStatus = 'error'
    const preparation = [{ callId: requested.id, args, result: correction }]
    db.exec("CREATE TRIGGER fail_correction BEFORE INSERT ON execution_message_bodies WHEN NEW.message_id='invalid-result' BEGIN SELECT RAISE(ABORT,'result failed'); END")
    expect(() => store.prepareTools(scope(store), preparation)).toThrow('result failed')
    expect(store.load('thread')).toEqual(original)
    db.exec('DROP TRIGGER fail_correction'); store.prepareTools(scope(store), preparation)
    db.close(); db = database(file, false); store = new NativeExecutionStore(db)
    expect(store.load('thread')!.calls[0]).toMatchObject({ prepared: true, args, result: correction })
    expect(db.prepare('SELECT * FROM execution_effects').all()).toEqual([])
    store.finishBatch(scope(store))
    expect(store.load('thread')!.phase).toBe('prepare_model')
    expect(store.load('thread')!.messages.map(message => message.id)).toEqual(['input', 'model', 'invalid-result'])
    expect(store.load('thread')!.context.modelCalls).toBe(1)
  })

  it('retains independently committed results across reopen, then appends a batch in call order', () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-native-state-'))
    roots.push(root)
    const file = join(root, 'state.sqlite'), first = database(file)
    let store = new NativeExecutionStore(first)
    begin(store)
    batch(store)
    store.settleCall(scope(store), 'right', { id: 'right-result', value: { kind: 'tool', resultFor: 'provider-repeated-id', content: 'right', artifact: { bytes: new Uint8Array([2, 4]) } } })
    expect(store.load('thread')!.messages.map(message => message.id)).toEqual(['input', 'model'])
    expect(() => store.finishBatch(scope(store))).toThrow('unanswered calls')
    first.close()
    store = new NativeExecutionStore(database(file, false))
    expect(store.load('thread')!.calls).toMatchObject([
      { id: 'left', providerCallId: 'provider-repeated-id' },
      { id: 'right', providerCallId: 'provider-repeated-id', result: { id: 'right-result', value: { kind: 'tool', resultFor: 'provider-repeated-id', content: 'right', artifact: { bytes: new Uint8Array([2, 4]) } } } }
    ])
    const savedRevision = store.load('thread')!.revisionId
    expect(store.settleCall(scope(store), 'right', { id: 'right-result', value: { kind: 'tool', resultFor: 'provider-repeated-id', content: 'right', artifact: { bytes: new Uint8Array([2, 4]) } } })).toBe(savedRevision)
    expect(() => store.settleCall(scope(store), 'right', result('right-result', 'different'))).toThrow('cannot be replaced')
    store.settleCall(scope(store), 'left', result('left-result', 'left'))
    store.finishBatch(scope(store), [input('direction', 'Continue with the new instruction')])
    const state = store.load('thread')!
    expect(state.messages.map(message => message.id)).toEqual(['input', 'model', 'left-result', 'right-result', 'direction'])
    expect(state.calls).toEqual([])
    expect(state.phase).toBe('prepare_model')
    store.finish(scope(store), 'completed')
    expect(store.load('thread')!.phase).toBe('completed')
  })

  it('commits application facts with the state and rolls back the entire change if its owner fails', () => {
    const db = database()
    db.exec('CREATE TABLE input_receipts (run_id TEXT PRIMARY KEY)')
    let fail = true
    const store = new NativeExecutionStore(db, commit => {
      if (commit.inputAccepted) db.prepare('INSERT INTO input_receipts VALUES (?)').run(commit.runId)
      if (fail) throw new Error('owner failed')
    })
    expect(() => begin(store)).toThrow('owner failed')
    expect(store.load('thread')).toBeUndefined()
    expect(db.prepare('SELECT * FROM input_receipts').all()).toEqual([])
    expect(db.prepare('SELECT * FROM execution_message_bodies').all()).toEqual([])
    fail = false
    begin(store)
    const before = store.load('thread')
    fail = true
    expect(() => batch(store)).toThrow('owner failed')
    expect(store.load('thread')).toEqual(before)
    expect(db.prepare('SELECT count(*) AS total FROM execution_message_bodies').get()).toEqual({ total: 1 })
    expect(db.prepare('SELECT * FROM input_receipts').all()).toEqual([{ run_id: 'run' }])
  })

  it('validates the complete approval generation and persists decisions atomically while siblings settle', () => {
    const db = database(), store = new NativeExecutionStore(db)
    db.exec('CREATE TABLE approved_calls (call_id TEXT PRIMARY KEY)')
    begin(store)
    batch(store)
    store.wait(scope(store), [approval()])
    store.settleCall(scope(store), 'right', result('right-result', 'saved sibling'))
    expect(store.load('thread')!.phase).toBe('waiting')
    expect(store.load('thread')!.approvals).toEqual([approval()])
    let applied = false
    expect(() => store.resolveWait(scope(store), { approval: 'obsolete' }, () => { applied = true })).toThrow('generation changed')
    expect(applied).toBe(false)
    expect(() => store.resolveWait(scope(store), { approval: 'generation-1' }, () => {
      db.prepare('INSERT INTO approved_calls VALUES (?)').run('left')
      throw new Error('decision failed')
    })).toThrow('decision failed')
    expect(db.prepare('SELECT * FROM approved_calls').all()).toEqual([])
    expect(store.load('thread')!.phase).toBe('waiting')
    store.resolveWait(scope(store), { approval: 'generation-1' }, () => {
      db.prepare('INSERT INTO approved_calls VALUES (?)').run('left')
    })
    expect(store.load('thread')!.approvals).toEqual([])
    expect(store.load('thread')!.phase).toBe('tools')
    expect(db.prepare('SELECT * FROM approved_calls').all()).toEqual([{ call_id: 'left' }])
  })

  it('still requires the entire ordinary access approval batch', () => {
    const store = new NativeExecutionStore(database())
    begin(store); batch(store)
    store.wait(scope(store), ['left', 'right'].map(id => ({ ...approval(), id, kind: 'tool', callIds: [id] })))
    const before = store.load('thread'), apply = () => { throw new Error('Must not grant partial access') }
    expect(() => store.resolveWait(scope(store), { left: 'generation-1' }, apply)).toThrow('generation changed')
    expect(store.load('thread')).toEqual(before)
  })

  it('keeps confirmed results on cancellation and never invents a result for unanswered calls', () => {
    const store = new NativeExecutionStore(database())
    begin(store)
    batch(store)
    store.settleCall(scope(store), 'right', result('right-result', 'confirmed'))
    store.wait(scope(store), [approval()])
    expect(() => store.finish(scope(store), 'completed')).toThrow('during waiting')
    store.finish(scope(store), 'cancelled')
    const cancelled = store.load('thread')!
    expect(cancelled.messages.map(message => message.id)).toEqual(['input', 'model', 'right-result'])
    expect(cancelled.calls).toEqual([])
    expect(cancelled.approvals).toEqual([])
    expect(() => store.settleCall({ threadId: 'thread', runId: 'run' }, 'left', result('late', 'late'))).toThrow('No tool batch')
    store.start({ threadId: 'thread', runId: 'next-run', expectedRevisionId: cancelled.revisionId,
      messages: [input('next-input', 'Check the actual state before trying again')], context: context() })
    expect(store.load('thread')!.messages.map(message => message.id)).toEqual(['input', 'model', 'right-result', 'next-input'])
    expect(() => store.settleCall({ threadId: 'thread', runId: 'run' }, 'left', result('late', 'late'))).toThrow('does not own')
  })

  it('rejects stale revisions and duplicate application call identities without appending a partial response', () => {
    const store = new NativeExecutionStore(database())
    begin(store)
    const before = store.load('thread')!
    const calls = [call('same'), call('same')]
    expect(() => store.acceptModel(scope(store), { id: 'model', value: { kind: 'assistant', content: 'proposal',
      calls: calls.map(call => ({ id: call.providerCallId, name: call.name, args: call.args })) } }, calls, context())).toThrow('UNIQUE constraint')
    expect(store.load('thread')).toEqual(before)
    batch(store)
    expect(() => store.finish({ threadId: 'thread', runId: 'run', expectedRevisionId: before.revisionId }, 'cancelled')).toThrow('revision changed')
    expect(() => store.start({ threadId: 'thread', runId: 'other', expectedRevisionId: store.load('thread')!.revisionId,
      messages: [], context: context() })).toThrow('still active')
  })

  it('reports corrupted bodies and invalid persisted counters rather than resetting the state', () => {
    const db = database(), store = new NativeExecutionStore(db)
    begin(store)
    const body = store.load('thread')!.messages[0]
    db.prepare('UPDATE execution_message_bodies SET value=? WHERE record_id=?').run(encodeExecutionValue('corrupt replacement'), body.recordId)
    expect(() => store.load('thread')).toThrow('does not match its content identity')
    db.prepare('UPDATE execution_message_bodies SET value=? WHERE record_id=?').run(encodeConversationMessage(body.value), body.recordId)
    db.prepare('UPDATE execution_state SET context_value=?').run(encodeExecutionValue({ model_calls: -1, todos: [] }))
    expect(() => store.load('thread')).toThrow('Invalid persisted execution context')
  })

  it('commits manual compression and its owner confirmation together without replacing original history', () => {
    const db = database()
    db.exec('CREATE TABLE summaries (id TEXT PRIMARY KEY, body TEXT)')
    let fail = true
    const store = new NativeExecutionStore(db, commit => {
      if (!commit.summary) return
      db.prepare('INSERT INTO summaries VALUES (?,?)').run(commit.summary.id, commit.summary.modelContent)
      if (fail) throw new Error('summary owner failed')
    })
    store.start({ threadId: 'thread', runId: 'run', messages: [input('input', 'Original history')],
      context: { ...context(), threadModelCalls: 7 } })
    const original = store.load('thread')!
    const summary = { id: 'summary', summaryText: 'Visible summary', modelContent: 'Model summary', cutoffIndex: 1,
      activatedAfterMessageIndex: 0, inputTokensBefore: 30, inputTokensAfter: 10 }
    expect(() => store.commitSummary(scope(store), summary, { completeRun: true })).toThrow('summary owner failed')
    expect(store.load('thread')).toEqual(original)
    expect(db.prepare('SELECT * FROM summaries').all()).toEqual([])
    fail = false
    store.commitSummary(scope(store), summary, { completeRun: true, sessionId: 'session' })
    const completed = store.load('thread')!
    expect(completed.phase).toBe('completed')
    expect(completed.messages).toEqual(original.messages)
    expect(completed.context).toMatchObject({ modelCalls: 0, threadModelCalls: 7, summary: { id: 'summary', cutoffIndex: 1, sessionId: 'session' } })
    expect(store.readMessageRecord('thread', completed.context.summary!.messageRecordId).value).toEqual({ kind: 'user', content: 'Model summary', context: { summary: true, summaryId: 'summary' } })
    expect(db.prepare('SELECT * FROM summaries').all()).toEqual([{ id: 'summary', body: 'Model summary' }])
  })

  it('rejects ambiguous approvals and unrelated results without changing the active batch', () => {
    const store = new NativeExecutionStore(database())
    begin(store)
    batch(store)
    const original = store.load('thread')
    expect(() => store.wait(scope(store), [approval(), { ...approval(), callIds: ['right'] }])).toThrow('Invalid persisted execution approvals')
    expect(() => store.wait(scope(store), [approval(), { ...approval(), id: 'other' }])).toThrow('approval call or policy')
    expect(() => store.wait(scope(store), [{ ...approval(), request: { actionRequests: [], reviewConfigs: [] } }])).toThrow('Invalid persisted execution approvals')
    expect(() => store.settleCall(scope(store), 'left', { id: 'result', value: { kind: 'tool', resultFor: 'unrelated', content: 'wrong' } })).toThrow('does not answer')
    expect(store.load('thread')).toEqual(original)
  })

  it('reports a missing message body instead of returning shortened conversation history', () => {
    const db = database(), store = new NativeExecutionStore(db)
    begin(store)
    db.pragma('foreign_keys = OFF')
    db.exec('DELETE FROM execution_message_bodies')
    expect(() => store.load('thread')).toThrow('Missing execution message body')
  })

  it('retains effect recovery ordinals and explicit empty choices across a cold reopen', () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-native-approval-'))
    roots.push(root)
    const file = join(root, 'state.sqlite'), first = database(file)
    const store = new NativeExecutionStore(first)
    begin(store)
    batch(store)
    const pending = approval()
    Object.assign(pending.request.actionRequests[0], { anasRecovery: { ordinal: 2, state: 'uncertain' } })
    pending.request.actionRequests[0].description = ''
    store.wait(scope(store), [pending])
    first.close()
    expect(new NativeExecutionStore(database(file, false)).load('thread')!.approvals).toEqual([pending])
  })

  it('distinguishes a saved model answer from permission to make the next model request', () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-native-model-result-'))
    roots.push(root)
    const file = join(root, 'state.sqlite'), first = database(file)
    let store = new NativeExecutionStore(first)
    begin(store)
    store.acceptModel(scope(store), { id: 'answer', value: { kind: 'assistant', content: 'done' } }, [], { ...context(), modelCalls: 1 })
    first.close()
    store = new NativeExecutionStore(database(file, false))
    expect(store.load('thread')!.phase).toBe('model_result')
    expect(() => store.acceptModel(scope(store), { id: 'duplicate', value: { kind: 'assistant', content: 'again' } }, [], context())).toThrow('during model_result')
    store.continueAfterModel(scope(store), [input('supervision', 'Read the outstanding background result')], { ...context(), modelCalls: 1 })
    expect(store.load('thread')!.phase).toBe('prepare_model')
    expect(store.load('thread')!.messages.map(message => message.id)).toEqual(['input', 'answer', 'supervision'])
    store.acceptModel(scope(store), { id: 'final', value: { kind: 'assistant', content: 'finished' } }, [], { ...context(), modelCalls: 2 })
    store.finish(scope(store), 'completed')
    expect(store.load('thread')!.context.modelCalls).toBe(2)
  })

  it('commits canonical arguments, grants and rejected siblings with the exact owning response version', () => {
    const db = database(), store = new NativeExecutionStore(db)
    begin(store)
    batch(store)
    const original = store.load('thread')!, args = { path: '/canonical/path' }
    const receipt = { id: 'left', name: 'fixture', inputHash: authorizationInputHash(args), requiresApproval: true, humanApproved: false,
      plan: { workingDir: '/workspace', executable: '/shell', paths: ['/canonical/path'],
        skillScript: { skillId: 'skill', root: '/skills', script: '/skills/script', executor: '/shell' } } }
    expect(() => store.prepareEffect({ threadId: 'thread', runId: 'run', callId: 'left' }, 'confirm')).toThrow('not completed preflight')
    store.prepareTools(scope(store), [
      { callId: 'left', args, authorization: { approval: 'pending', shell: receipt } },
      { callId: 'right', args: call('right').args, result: result('right-result', 'invalid input') }
    ], [{ ...approval(), kind: 'tool', request: { actionRequests: [{ name: 'fixture', args, description: '' }],
      reviewConfigs: [{ actionName: 'fixture', allowedDecisions: ['approve', 'reject'] }] } }])
    const waiting = store.load('thread')!
    expect(waiting.phase).toBe('waiting')
    expect(waiting.calls[0]).toMatchObject({ prepared: true, args, authorization: { approval: 'pending', shell: receipt } })
    expect(waiting.calls[1].result!.value.content).toBe('invalid input')
    expect(waiting.response!.recordId).not.toBe(original.response!.recordId)
    expect(waiting.response!.value.calls![0].args).toEqual(args)
    expect(store.readMessageRecord('thread', original.response!.recordId)).toEqual(original.response)
    expect(() => store.prepareEffect({ threadId: 'thread', runId: 'run', callId: 'left' }, 'confirm')).toThrow('not completed preflight')
    const pendingScope = scope(store)
    expect(() => store.grantToolApprovals(pendingScope, ['left'])).toThrow('matching approval transaction')
    expect(() => store.resolveWait(pendingScope, { approval: 'generation-1' }, () => {
      store.grantToolApprovals(pendingScope, ['left'])
      throw new Error('receipt failure')
    })).toThrow('receipt failure')
    expect(store.load('thread')).toEqual(waiting)
    store.resolveWait(pendingScope, { approval: 'generation-1' }, () => store.grantToolApprovals(pendingScope, ['left']))
    expect(store.load('thread')!.calls[0].authorization).toEqual({ approval: 'granted', shell: { ...receipt, humanApproved: true } })
    expect(store.prepareEffect({ threadId: 'thread', runId: 'run', callId: 'left' }, 'confirm').argsJson).toBe(JSON.stringify(args))
  })

  it('rolls back incomplete preflight or receipts bound to different arguments', () => {
    const store = new NativeExecutionStore(database())
    begin(store)
    batch(store)
    const original = store.load('thread')
    expect(() => store.prepareTools(scope(store), [{ callId: 'left', args: {} }])).toThrow('entire unprepared batch')
    expect(() => store.prepareTools(scope(store), [
      { callId: 'left', args: {}, authorization: { shell: { id: 'left', name: 'fixture', inputHash: authorizationInputHash({ different: true }),
        humanApproved: false, requiresApproval: false } } }, { callId: 'right', args: {} }
    ])).toThrow('authorization does not match')
    expect(store.load('thread')).toEqual(original)
  })

  it('commits planning updates with their result exactly once and preserves them on cancellation', () => {
    const db = database()
    let fail = false
    const store = new NativeExecutionStore(db, commit => {
      if (fail && commit.messageRecords.some(message => message.id === 'plan-result')) throw new Error('result owner failed')
    })
    begin(store)
    batch(store)
    const update = { todos: [{ content: 'Inspect files', status: 'in_progress' as const }] }, message = result('plan-result', 'plan saved')
    const original = store.load('thread')!
    fail = true
    expect(() => store.settleCall(scope(store), 'left', message, update)).toThrow('result owner failed')
    expect(store.load('thread')).toEqual(original)
    fail = false
    store.settleCall(scope(store), 'left', message, update)
    const saved = store.load('thread')!
    expect(saved.context.todos).toEqual(update.todos)
    expect(store.settleCall(scope(store), 'left', message, update)).toBe(saved.revisionId)
    expect(() => store.settleCall(scope(store), 'left', message, { todos: [] })).toThrow('cannot be replaced')
    store.finish(scope(store), 'cancelled')
    expect(store.load('thread')!.context.todos).toEqual(update.todos)
  })

  it('activates automatic compression with the corresponding model response in one commit', () => {
    const db = database()
    let fail = true
    const store = new NativeExecutionStore(db, commit => { if (commit.summary && fail) throw new Error('summary confirmation failed') })
    begin(store)
    const original = store.load('thread')!
    const summary = { id: 'summary', summaryText: 'visible', modelContent: 'model summary', cutoffIndex: 1,
      activatedAfterMessageIndex: 0, inputTokensBefore: 100, inputTokensAfter: 20 }
    const response = { id: 'answer', value: { kind: 'assistant' as const, content: 'response to compressed request' } }
    expect(() => store.acceptModel(scope(store), response, [], { ...context(), modelCalls: 1 }, summary)).toThrow('summary confirmation failed')
    expect(store.load('thread')).toEqual(original)
    expect(db.prepare('SELECT count(*) AS total FROM execution_message_bodies').get()).toEqual({ total: 1 })
    fail = false
    store.acceptModel(scope(store), response, [], { ...context(), modelCalls: 1 }, summary)
    expect(store.load('thread')).toMatchObject({ phase: 'model_result', response: { id: 'answer' }, context: { modelCalls: 1, summary: { id: 'summary', cutoffIndex: 1 } } })
  })

  it('never turns an incomplete model response into executable calls', () => {
    const store = new NativeExecutionStore(database())
    begin(store)
    const original = store.load('thread')
    expect(() => store.acceptModel(scope(store), { id: 'partial', value: { kind: 'assistant', content: '', partial: true } }, [call('left')], context())).toThrow('incomplete model response')
    expect(store.load('thread')).toEqual(original)
  })
})
