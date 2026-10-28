import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ExecutionMessageInput, ExecutionToolCall } from '../../runtime/executionState'
import * as messageStorage from '../../runtime/conversationStorage'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import { getAgentConversationDatabaseFile } from '../config/dataDir'
import { AgentStorage } from './agentStorage'
import { NativeExecutionStore } from './nativeExecutionStore'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'anas-native-current-storage-'))
  const storage = AgentStorage.openNative(directory), thread = storage.createThread()
  const database = storage.conversationForThread(thread.id), owner = database.runs
  return { database, owner, thread,
    raw: () => new Database(getAgentConversationDatabaseFile(thread.id, directory)),
    create(runId: string, inputId = runId + '-input') {
      const identity = { threadId: thread.id, runId }
      owner.createRun({ ...identity, operation: 'agent', message: {
        id: inputId, value: { id: inputId, kind: 'user', content: 'Instruction', context: { runId } }
      } })
      return identity
    },
    scope(runId: string) { return { threadId: thread.id, runId, expectedRevisionId: owner.store.load(thread.id)!.revisionId } },
    close() { vi.restoreAllMocks(); storage.close(); rmSync(directory, { recursive: true, force: true }) }
  }
}
function call(index: number): ExecutionToolCall {
  const id = 'call-' + index
  return { id, providerCallId: id, name: 'lookup', args: { index },
    artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, id + ':' + purpose])) as ExecutionToolCall['artifacts'] }
}
function appendTool(h: ReturnType<typeof fixture>, runId: string, index: number, content = 'result ' + index) {
  const requested = call(index)
  h.owner.store.acceptModel(h.scope(runId), { id: 'model-' + index, value: { kind: 'assistant', content: '',
    calls: [{ id: requested.providerCallId, name: requested.name, args: requested.args }] } }, [requested], { modelCalls: index + 1, todos: [] })
  h.owner.store.prepareTools(h.scope(runId), [{ callId: requested.id, args: requested.args }])
  h.owner.store.settleCall({ threadId: h.thread.id, runId }, requested.id,
    { id: 'result-' + index, value: { kind: 'tool', resultFor: requested.id, content } })
  h.owner.store.finishBatch(h.scope(runId))
}

describe('conversation current storage integration', () => {
  it('loads one tool without hydrating other tools or models in the same run', async () => {
    const h = fixture()
    try {
      const identity = h.create('tools-run')
      await h.owner.enter('input', identity)
      for (let index = 0; index < 100; index += 1) appendTool(h, identity.runId, index)
      const activities = h.database.messages.activities
      const allActivities = vi.spyOn(activities, 'getRunActivity').mockImplementation(() => { throw new Error('A tool lookup must not read the whole run') })
      const bodyRead = vi.spyOn(NativeExecutionStore.prototype, 'readMessageRecord')
      expect(activities.getToolActivity(identity.runId, 'call-42')).toMatchObject({
        call: { id: 'call-42', name: 'lookup', args: { index: 42 } }, output: 'result 42', status: 'completed'
      })
      expect(allActivities).not.toHaveBeenCalled()
      expect(bodyRead.mock.results.map(result => result.value?.id)).toEqual(['model-42', 'result-42'])
      expect(activities.getToolActivity(identity.runId, 'absent')).toBeUndefined()
    } finally { h.close() }
  })

  it('appends to a long conversation without encoding old message bodies and reads only the requested UI window', () => {
    const h = fixture()
    try {
      const identity = h.create('long-run', 'input-0')
      const messages: ExecutionMessageInput[] = Array.from({ length: 1000 }, (_, index) => ({
        id: 'input-' + index, value: { id: 'input-' + index, kind: 'user', content: index + ':' + 'x'.repeat(4096), context: { runId: identity.runId } }
      }))
      const encoded = vi.spyOn(messageStorage, 'encodeConversationMessage')
      const bytes = () => encoded.mock.results.reduce((total, result) => total + Buffer.byteLength(result.value), 0)
      h.owner.store.start({ ...identity, expectedRevisionId: h.owner.store.readHistory(h.thread.id)?.revisionId,
        messages, context: { modelCalls: 0, todos: [] } })
      expect(bytes()).toBeGreaterThan(4_000_000)
      encoded.mockClear()
      for (let index = 0; index < 20; index += 1) {
        const context = { modelCalls: index + 1, todos: [] }
        h.owner.store.acceptModel(h.scope(identity.runId), { id: 'answer-' + index,
          value: { kind: 'assistant', content: 'answer'.repeat(100) } }, [], context)
        h.owner.store.continueAfterModel(h.scope(identity.runId), [], context)
      }
      expect(bytes()).toBeLessThan(50_000)
      const history = vi.spyOn(NativeExecutionStore.prototype, 'readHistory').mockImplementation(() => { throw new Error('A page must not load the whole history') })
      const bodyRead = vi.spyOn(NativeExecutionStore.prototype, 'readMessageRecord')
      const window = h.database.messages.window(h.thread.id, undefined, 25)
      expect(window).toMatchObject({ totalCount: 1020, startIndex: 995 })
      expect(window.messages).toHaveLength(25)
      expect(window.messages.at(-1)).toMatchObject({ id: 'answer-19', role: 'assistant', content: [{ type: 'text', text: 'answer'.repeat(100) }] })
      expect(bodyRead).toHaveBeenCalledTimes(25)
      expect(history).not.toHaveBeenCalled()
      history.mockRestore()
      expect(h.owner.store.readHistory(h.thread.id)?.messages).toHaveLength(1020)
    } finally { h.close() }
  }, 15_000)

  it('removes tool result payloads with the discarded run even when native tool messages have no run metadata', async () => {
    const h = fixture()
    try {
      const first = h.create('first')
      await h.owner.enter('input', first)
      h.owner.store.acceptModel(h.scope(first.runId), { id: 'first-answer', value: { kind: 'assistant', content: 'Keep' } }, [], { modelCalls: 1, todos: [] })
      h.owner.store.finish(h.scope(first.runId), 'completed')
      const second = h.create('second')
      await h.owner.enter('input', second)
      appendTool(h, second.runId, 0, 'discard'.repeat(1000))
      h.owner.store.acceptModel(h.scope(second.runId), { id: 'second-answer', value: { kind: 'assistant', content: 'Done' } }, [], { modelCalls: 2, todos: [] })
      h.owner.store.finish(h.scope(second.runId), 'completed')
      h.database.history.commit(h.database.history.prepare({ threadId: h.thread.id, messageId: 'second-input', kind: 'truncate' }))
      const raw = h.raw()
      try {
        expect(raw.prepare('SELECT message_id FROM execution_message_bodies ORDER BY message_id').all()).toEqual([{ message_id: 'first-answer' }, { message_id: 'first-input' }])
        expect(raw.prepare('SELECT * FROM agent_tool_messages').all()).toEqual([])
      } finally { raw.close() }
      expect(h.database.readModel.getRun(second.runId)).toBeNull()
    } finally { h.close() }
  })
})
