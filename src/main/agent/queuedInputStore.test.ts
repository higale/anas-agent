import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentStorage } from './agentStorage'
import { NativeRunHost } from './nativeRunHost'
import { ManagedCallService } from './managedCallService'
import { nativeCapabilityFixture } from '../../test/nativeCapabilityFixture'
import type { ExecutionToolCall } from '../../runtime/executionState'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import Database from 'better-sqlite3'
import { initializeNativeConversationStorage } from './nativeDatabaseSchema'
import { NativeRunOwner } from './nativeRunOwner'
import { QueuedInputStore } from './queuedInputStore'
import { archiveAgentAttachments } from './agentAttachmentStore'

const temporaryDirectories: string[] = []
const storages: AgentStorage[] = []
function openStorage(root: string) { const storage = AgentStorage.openNative(root); storages.push(storage); return storage }

afterEach(async () => {
  for (const storage of storages.splice(0)) storage.close()
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )))
})

describe('durable queued inputs', () => {
  it('preserves native queue ownership and retry across reopen without starting execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-native-queue-'))
    temporaryDirectories.push(root)
    const file = join(root, 'conversation.sqlite'), attachmentRoot = join(root, 'attachments'), source = join(root, 'notes.txt')
    let database = new Database(file)
    try {
      initializeNativeConversationStorage(database)
      const owner = new NativeRunOwner(database), thread = owner.createThread(), other = owner.createThread()
      await writeFile(source, 'Native queued attachment')
      const archived = await archiveAgentAttachments([{ path: source, name: 'notes.txt', mimeType: 'text/plain', size: 24, kind: 'text', contextPolicy: 'one_turn' }],
        { threadId: thread.id, runId: 'queued', messageId: 'queued' }, attachmentRoot)
      let queue = new QueuedInputStore(database, attachmentRoot)
      expect(() => queue.createQueuedInput({ id: 'wrong-owner', threadId: other.id, text: 'Wrong' }, archived)).toThrow('does not belong')
      expect(queue.listQueuedInputs()).toEqual([])
      expect(() => queue.createQueuedInput({ id: 'queued', threadId: thread.id, text: 'Expanded prompt', displayText: '' }, archived)).toThrow('CHECK constraint failed')
      expect(queue.listQueuedInputs()).toEqual([])
      queue.createQueuedInput({ id: 'queued', threadId: thread.id, text: 'Expanded prompt', displayText: '/review' }, archived)
      expect(() => queue.markQueuedInputFailed(other.id, 'queued', 'Wrong owner')).toThrow('not found')
      expect(queue.deleteQueuedInput(other.id, 'queued')).toBe(false)
      queue.markQueuedInputFailed(thread.id, 'queued', 'Provider unavailable')
      await rm(source)
      database.close(); database = new Database(file); initializeNativeConversationStorage(database)
      queue = new QueuedInputStore(database, attachmentRoot)
      expect(queue.getQueuedInput(thread.id, 'queued')).toMatchObject({ status: 'failed', error: 'Provider unavailable', displayText: '/review',
        attachments: [expect.objectContaining({ path: archived[0].artifact.path, contextPolicy: 'one_turn' })] })
      await expect(readFile(archived[0].artifact.path, 'utf8')).resolves.toBe('Native queued attachment')
      await rm(archived[0].artifact.path)
      const retried = queue.retryQueuedInput(thread.id, 'queued')
      expect(retried.status).toBe('queued')
      expect(retried).not.toHaveProperty('error')
      expect(retried.attachments[0].skippedReason).toBe('Queued attachment is no longer available.')
      expect(database.prepare('SELECT id FROM agent_runs').all()).toEqual([])
      expect(new NativeRunOwner(database).store.load(thread.id)).toBeUndefined()
      expect(queue.deleteQueuedInput(thread.id, 'queued')).toBe(true)
      expect(queue.listQueuedInputAttachmentArtifacts(thread.id, 'queued')).toEqual([])
    } finally { database.close() }
  })

  it('survives database reopen with an owned attachment and supports failure retry and removal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-queued-input-'))
    temporaryDirectories.push(root)
    const source = join(root, 'notes.txt')
    await writeFile(source, 'durable queued content', 'utf8')

    let storage = openStorage(root)
    const thread = storage.createThread({ title: 'Queued input' })
    let database = storage.conversationForThread(thread.id)
    let runtime = new NativeRunHost(database, new ManagedCallService(database.managed, database.results), { push: () => {} })
    const id = randomUUID()
    const created = await runtime.enqueueQueuedInput({
      id,
      threadId: thread.id,
      text: 'Expanded skill prompt',
      displayText: '/review current changes',
      attachments: [{
        path: source,
        name: 'notes.txt',
        mimeType: 'text/plain',
        size: 22,
        kind: 'text',
        contextPolicy: 'conversation'
      }]
    })
    const storedPath = created.attachments[0].path
    await rm(source)
    await runtime.shutdown()
    storage.close()

    storage = openStorage(root)
    database = storage.conversationForThread(thread.id)
    runtime = new NativeRunHost(database, new ManagedCallService(database.managed, database.results), { push: () => {} })
    expect(runtime.listQueuedInputs()).toEqual([
      expect.objectContaining({
        id,
        threadId: thread.id,
        text: 'Expanded skill prompt',
        displayText: '/review current changes',
        status: 'queued',
        attachments: [expect.objectContaining({
          path: storedPath,
          name: 'notes.txt',
          contextPolicy: 'conversation'
        })]
      })
    ])
    await expect(readFile(storedPath, 'utf8')).resolves.toBe('durable queued content')

    expect(runtime.markQueuedInputFailed(thread.id, id, 'Provider unavailable')).toMatchObject({
      status: 'failed',
      error: 'Provider unavailable'
    })
    const retried = runtime.retryQueuedInput(thread.id, id)
    expect(retried).toMatchObject({ status: 'queued' })
    expect(retried).not.toHaveProperty('error')
    await expect(runtime.removeQueuedInput(thread.id, id)).resolves.toBe(true)
    expect(runtime.listQueuedInputs()).toEqual([])
    await expect(stat(storedPath)).rejects.toThrow()
    await runtime.shutdown()
    storage.close()
  })

  it('consumes an applied direction only after its message identity is committed', async () => {
    const h = nativeCapabilityFixture(), { database, thread, run } = h
    const owner = { threadId: thread.id, runId: run.id }, id = randomUUID()
    const store = database.runs.store, scope = () => ({ ...owner, expectedRevisionId: store.load(thread.id)!.revisionId })
    try {
      await database.runs.enter('input', owner)
      database.queue.createQueuedInput({ id, threadId: thread.id, text: 'Use the committed direction' }, [])
      expect(database.runs.queueDirection(owner, id)).toBe(true)
      const call: ExecutionToolCall = { id: 'inspect', providerCallId: 'inspect', name: 'read_file', args: {},
        artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, randomUUID()])) as ExecutionToolCall['artifacts'] }
      store.acceptModel(scope(), { id: 'response', value: { kind: 'assistant', content: '', calls: [{ id: 'inspect', name: call.name, args: {} }] } },
        [call], { modelCalls: 1, todos: [] })
      store.prepareTools(scope(), [{ callId: call.id, args: {} }])
      store.settleCall(owner, call.id, { id: 'result', value: { kind: 'tool', resultFor: 'inspect', content: 'Read result' } })
      const directions = await database.runs.directions(store.load(thread.id)!)
      expect(directions.map(message => message.id)).toEqual([run.id + ':direction:' + id])
      expect(database.queue.listQueuedInputs()).toHaveLength(1)
      expect(store.readHistory(thread.id)!.messages.some(message => message.id === directions[0].id)).toBe(false)
      store.finishBatch(scope(), directions)
      expect(database.queue.listQueuedInputs()).toEqual([])
      expect(store.readHistory(thread.id)!.messages.at(-1)).toMatchObject({ id: directions[0].id, value: { content: 'Use the committed direction' } })
    } finally { await h.close() }
  })
})
