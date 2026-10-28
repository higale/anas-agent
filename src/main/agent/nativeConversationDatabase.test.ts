import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { SqliteMemoryStore } from './memoryStore'
import { FileEditStore } from '../fileEditStore'
import { defaultCapabilities } from '../../shared/agentCapabilities'

describe('native conversation connection ownership', () => {
  it('shares submission, projection, queue and catalog facts across reopen without owning global memory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-native-database-')), file = join(root, 'conversation.sqlite')
    const global = new Database(':memory:'), memoryStore = new SqliteMemoryStore(global)
    const options = { attachmentRoot: join(root, 'attachments'), memoryStore, fileEditStore: new FileEditStore(join(root, 'file_edits')) }
    let database = NativeConversationDatabase.open(file, options)
    try {
      const identity = { threadId: 'thread', runId: 'run' }
      database.runs.createThreadAndRun({ ...identity, thread: { title: 'Persistent conversation' }, submissionId: 'submission',
        message: { id: 'run:input', value: { id: 'run:input', kind: 'user', content: 'Question', context: { runId: 'run' } } } })
      database.queue.createQueuedInput({ id: 'queued', threadId: 'thread', text: 'Next question' }, [])
      const configuration = { codingMode: false, customTools: [], capabilities: { ...structuredClone(defaultCapabilities), tools: [], backgroundTools: false } }
      database.runs.resolveRunConfiguration(identity, configuration)
      expect(() => database.runs.resolveRunConfiguration({ ...identity, threadId: 'other' }, configuration)).toThrow('does not belong')
      expect(() => database.runs.resolveRunConfiguration(identity, { ...configuration, codingMode: true })).toThrow('already fixed')
      expect(database.readCatalogSnapshot('thread')).toMatchObject({ thread: { status: 'running', userTurnCount: 1 },
        hasQueuedInputs: true, runs: [{ id: 'run', threadId: 'thread', submissionId: 'submission' }] })
      database.close(); database.close()
      expect(global.open).toBe(true)
      database = NativeConversationDatabase.open(file, options)
      expect(database.resources.memoryStore).toBe(memoryStore)
      expect(database.runs.getRunConfiguration(identity)).toEqual(configuration)
      expect(database.runs.store.load('thread')).toBeUndefined()
      await database.execution.enter('input', { ...identity, signal: new AbortController().signal })
      const scope = () => ({ ...identity, expectedRevisionId: database.runs.store.load('thread')!.revisionId })
      database.runs.store.acceptModel(scope(), { id: 'answer', value: { id: 'answer', kind: 'assistant', content: 'Saved response' } }, [], { modelCalls: 1, todos: [] })
      database.runs.store.finish(scope(), 'completed')
      database.validate()
      database.close(); database = NativeConversationDatabase.open(file, options)
      expect(database.messages.window('thread').messages.map(message => message.content)).toEqual([
        [{ type: 'text', text: 'Question' }], [{ type: 'text', text: 'Saved response' }]
      ])
      expect(database.readCatalogSnapshot('thread')).toMatchObject({ thread: { status: 'idle' }, hasQueuedInputs: true })
      expect(database.queue.getQueuedInput('thread', 'queued')).toMatchObject({ text: 'Next question', status: 'queued' })
      await database.execution.enter('continue', { ...identity, signal: new AbortController().signal })
      expect(database.runs.store.load('thread')!.phase).toBe('completed')
    } finally { database.close(); global.close(); rmSync(root, { recursive: true, force: true }) }
  })

  it.each(['legacy', 'damaged body'] as const)('rejects %s without repairing it or retaining its file handle', async kind => {
    const root = mkdtempSync(join(tmpdir(), 'anas-native-database-reject-')), file = join(root, 'conversation.sqlite')
    const global = new Database(':memory:'), options = { attachmentRoot: join(root, 'attachments'),
      memoryStore: new SqliteMemoryStore(global), fileEditStore: new FileEditStore(join(root, 'file_edits')) }
    try {
      if (kind === 'damaged body') {
        const owner = NativeConversationDatabase.open(file, options)
        try {
          owner.runs.createThreadAndRun({ threadId: 'thread', runId: 'run', thread: {}, submissionId: 'submission',
            message: { id: 'run:input', value: { id: 'run:input', kind: 'user', content: 'Question', context: { runId: 'run' } } } })
          await owner.execution.enter('input', { threadId: 'thread', runId: 'run', signal: new AbortController().signal })
        } finally { owner.close() }
      }
      const raw = new Database(file)
      try {
        if (kind === 'legacy') raw.exec('CREATE TABLE current_state(value TEXT)')
        else raw.exec("UPDATE execution_message_bodies SET value=x'00'")
        raw.pragma('wal_checkpoint(TRUNCATE)'); raw.pragma('journal_mode=DELETE')
      } finally { raw.close() }
      const before = readFileSync(file)
      expect(() => NativeConversationDatabase.open(file, options)).toThrow()
      expect(readFileSync(file)).toEqual(before)
      expect(global.open).toBe(true)
      rmSync(file)
    } finally { global.close(); rmSync(root, { recursive: true, force: true }) }
  })
})
