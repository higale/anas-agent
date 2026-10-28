import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { NativeRunHost } from './nativeRunHost'
import { ManagedCallService } from './managedCallService'
import { SqliteMemoryStore } from './memoryStore'
import { FileEditStore } from '../fileEditStore'
import { resolveFilePatchTargets } from '../filePatch'
import { captureFilePatchPreimages } from '../filePatchState'
import { asPatchInput } from '../filePatchTestFixtures'
import { archiveAgentAttachments } from './agentAttachmentStore'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import type { ExecutionToolCall } from '../../runtime/executionState'
import { runWithCurrentAgentToolEffect } from './toolEffectScope'

vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'anas-native-resource-cleanup-'))), global = new Database(':memory:')
  const file = join(root, 'conversation.sqlite'), attachmentRoot = join(root, 'attachments')
  const fileEditStore = new FileEditStore(join(root, 'file_edits')), memoryStore = new SqliteMemoryStore(global)
  let database = NativeConversationDatabase.open(file, { attachmentRoot, fileEditStore, memoryStore })
  const threadId = randomUUID(); database.runs.createThread({}, threadId)
  let host = new NativeRunHost(database, new ManagedCallService(database.managed, database.results), { push() {} })
  return { root, file, attachmentRoot, fileEditStore, threadId, get database() { return database }, get host() { return host },
    scope(runId: string) { return { threadId, runId, expectedRevisionId: database.runs.store.load(threadId)!.revisionId } },
    async input(runId: string, attachment = false) {
      const id = `${runId}:input`, path = join(root, `${runId}.txt`); writeFileSync(path, 'Attachment source')
      const attachments = attachment ? await archiveAgentAttachments([{ path, name: 'input.txt', mimeType: 'text/plain', kind: 'text', size: 17, contextPolicy: 'conversation' }],
        { threadId, runId, messageId: id }, attachmentRoot) : []
      database.runs.createRun({ threadId, runId, operation: 'agent', attachments,
        message: { id, value: { id, kind: 'user', content: 'Task', context: { runId } } } })
      await database.runs.enter('input', { threadId, runId })
      return attachments
    },
    reopen() { database.close(); database = NativeConversationDatabase.open(file, { attachmentRoot, fileEditStore, memoryStore });
      host = new NativeRunHost(database, new ManagedCallService(database.managed, database.results), { push() {} }) },
    async close() { await host.waitForIdle(); database.validate(); database.close(); global.close(); rmSync(root, { recursive: true, force: true }) }
  }
}

it('archives confirmed file changes and keeps unaccepted recovery material when a terminal native run drains', async () => {
  const h = fixture(), runId = randomUUID(), ids = [randomUUID(), randomUUID()]
  try {
    await h.input(runId)
    const calls: ExecutionToolCall[] = ids.map(id => ({ id, name: 'apply_patch', args: {}, providerCallId: id,
      artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, randomUUID()])) as ExecutionToolCall['artifacts'] }))
    h.database.runs.store.acceptModel(h.scope(runId), { id: 'response', value: { kind: 'assistant', content: '', calls: calls.map(call => ({ id: call.id, name: call.name, args: call.args })) } }, calls, { modelCalls: 1, todos: [] })
    h.database.runs.store.prepareTools(h.scope(runId), calls.map(call => ({ callId: call.id, args: call.args })))
    for (const id of ids) {
      const target = join(h.root, `${id}.txt`)
      const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [{ type: 'create', path: target, content: 'Saved change\n' }] }), h.root)
      const key = { threadId: h.threadId, runId, callId: id }
      h.database.runs.store.prepareEffect(key, 'confirm')
      await runWithCurrentAgentToolEffect({
        arm: effect => h.database.runs.store.armEffect(key, { kind: effect.kind, target: effect.target }),
        persistFileChange: (record, observed) => h.database.resources.fileChanges.persist(record, observed)
      }, async () => h.fileEditStore.executePatch(resolved.input, await captureFilePatchPreimages(resolved.targets), runId, { operationId: id }))
    }
    const result = { id: 'accepted:result', value: { kind: 'tool' as const, resultFor: ids[0], content: 'Saved change' } }
    h.database.runs.store.saveEffectResult({ threadId: h.threadId, runId, callId: ids[0] }, result)
    h.database.runs.store.settleCall({ threadId: h.threadId, runId }, ids[0], result)
    h.database.runs.store.finish(h.scope(runId), 'failed', 'Second result was not accepted')
    expect(h.database.resourceCleanup.listRetainedFileEditOperationIds(runId)).toEqual([ids[1]])
    const create = vi.fn(async () => { throw new Error('Terminal run must not execute') })
    const handle = h.host.start({ threadId: h.threadId, runId }, 'continue', create)
    expect((await handle.completed).status).toBe('failed'); await handle.drained
    expect(create).not.toHaveBeenCalled()
    expect(h.database.resourceCleanup.listFileEditCleanupRunIds()).toEqual([])
    await expect(h.fileEditStore.loadOperationRecord(ids[0], runId)).rejects.toThrow()
    expect((await h.fileEditStore.loadOperationRecord(ids[1], runId)).transaction.state).toBe('retained')
    for (const id of ids) expect(readFileSync(join(h.root, `${id}.txt`), 'utf8')).toBe('Saved change\n')
    expect(h.database.resources.fileChanges.listRounds({ threadId: h.threadId }).rounds).toHaveLength(1)
    const files = h.database.resources.fileChanges.queryRoundFiles({ runId })
    expect(files.files).toHaveLength(2)
    expect(h.database.resources.fileChanges.readRoundContent({ runId, filePath: join(h.root, `${ids[0]}.txt`), version: files.version }))
      .toMatchObject({ status: 'ready', before: '', after: 'Saved change\n' })
  } finally { await h.close() }
})

it.each([
  { content: 'Visible\nrequest', summary: 'Visible request' },
  { content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,hidden' } }, { type: 'text', text: 'Block label' }], summary: 'Block label' },
  { content: 'Internal skill prompt', displayText: '', summary: '' },
  { content: 'Internal skill prompt', displayText: 'Visible request '.repeat(20), summary: 'Visible request '.repeat(20).slice(0, 160).trim() }
])('reads bounded round labels from saved native input and exact accepted history: $summary', async ({ content, displayText, summary }) => {
  const h = fixture(), runId = randomUUID(), id = `${runId}:input`
  try {
    h.database.runs.createRun({ threadId: h.threadId, runId, operation: 'agent',
      message: { id, value: { id, kind: 'user', content, context: { runId, ...(displayText === undefined ? {} : { displayText }) } } } })
    expect(h.database.messages.roundSummary(h.threadId, runId)).toBe(summary)
    expect(h.database.messages.roundSummary('another-thread', runId)).toBe('')
    await h.database.runs.enter('input', { threadId: h.threadId, runId })
    expect(h.database.messages.roundSummary(h.threadId, runId)).toBe(summary)
    h.database.runs.store.finish(h.scope(runId), 'completed')
    h.reopen()
    expect(h.database.messages.roundSummary(h.threadId, runId)).toBe(summary)
  } finally { await h.close() }
})

it('leaves failed cleanup durable and retries after reopening without changing the final outcome', async () => {
  const h = fixture(), runId = randomUUID()
  try {
    await h.input(runId)
    h.database.runs.store.finish(h.scope(runId), 'cancelled')
    const cleanup = vi.spyOn(h.fileEditStore, 'deleteFileEditRecordsForRequest').mockRejectedValueOnce(new Error('Filesystem temporarily unavailable'))
    const handle = h.host.start({ threadId: h.threadId, runId }, 'continue', async () => { throw new Error('No execution expected') })
    expect((await handle.completed).status).toBe('cancelled'); await handle.drained
    expect(h.database.resourceCleanup.listFileEditCleanupRunIds()).toEqual([runId])
    expect(cleanup).toHaveBeenCalledOnce()
    h.reopen(); await h.host.cleanupResources()
    expect(cleanup).toHaveBeenCalledTimes(2)
    expect(h.database.resourceCleanup.listFileEditCleanupRunIds()).toEqual([])
    expect(h.database.messages.activities.getRun(runId)?.status).toBe('cancelled')
    await h.host.cleanupResources(); expect(cleanup).toHaveBeenCalledTimes(2)
  } finally { await h.close() }
})

it('deletes only discarded archived attachments after native history truncation and reopening', async () => {
  const h = fixture(), first = randomUUID(), second = randomUUID()
  try {
    const kept = await h.input(first, true); h.database.runs.store.finish(h.scope(first), 'completed')
    const discarded = await h.input(second, true); h.database.runs.store.finish(h.scope(second), 'completed')
    h.database.history.commit(h.database.history.prepare({ threadId: h.threadId, messageId: `${second}:input`, kind: 'truncate' }))
    expect(h.database.resourceCleanup.listAttachmentFileCleanup()).toHaveLength(1)
    h.reopen(); await h.host.cleanupResources()
    expect(existsSync(kept[0].artifact.path)).toBe(true)
    expect(existsSync(discarded[0].artifact.path)).toBe(false)
    expect(h.database.resourceCleanup.listAttachmentFileCleanup()).toEqual([])
    expect(h.database.runs.store.readHistory(h.threadId)?.messages.map(message => message.id)).toEqual([`${first}:input`])
  } finally { await h.close() }
})
