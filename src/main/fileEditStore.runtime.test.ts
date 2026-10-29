import { toolEffectArtifactPurposes, type ToolEffectArtifactIdentity } from '../runtime/toolEffectIdentity'
import { invokeCapability } from '../runtime/toolInvocation'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { configureDataRuntime, getDataDir, getFileEditRecordsDir } from './config/dataDir'
import { FileEditStore, pathExists } from './fileEditStore'
import { fileToolDefinitions } from './llm/fileTools'
import { runWithCurrentAgentToolEffect } from './agent/toolEffectScope'
import { withApplicationDataSnapshot } from './applicationDataSnapshot'
import { AgentStorage } from './agent/agentStorage'

// Static imports run before profile configuration, as they do in the main entry.
// Even a regression must never write to the developer's real home directory.
const home = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  return mkdtempSync(join(tmpdir(), 'anas-file-edit-runtime-'))
})
vi.mock('node:os', async (original) => ({
  ...await original<typeof import('node:os')>(), homedir: () => home
}))
vi.mock('electron', () => ({ app: { isPackaged: false, setPath: vi.fn() } }))

afterAll(() => rm(home, { recursive: true, force: true }))

function selectProfile(name: string): string {
  configureDataRuntime(['electron', 'app', '--data-dir', join(home, name)])
  return getDataDir()
}

function writeTool(primaryFolder: string, requestId: string, fileEditStore?: FileEditStore) {
  return fileToolDefinitions({ primaryFolder, requestId, maxReadBytes: 1_000_000,
    toolNames: ['write_file'], authorizePatch: async () => {}, fileEditStore })[0]
}

function effectIdentity(runId: string): ToolEffectArtifactIdentity {
  return { runId, artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, randomUUID()])) as ToolEffectArtifactIdentity['artifacts'] }
}

async function write(tool: ReturnType<typeof writeTool>, requestId: string, name: string) {
  const result = await runWithCurrentAgentToolEffect({
    identity: effectIdentity(requestId),
    isUnarmed: () => true, arm: () => {}
  }, () => invokeCapability(tool, { path: name, content: name, summary: 'Write profile fixture' }, {}))
  const output = JSON.parse(result.content as string) as { ok: boolean; operationId: string }
  expect(output).toMatchObject({ ok: true, operationId: expect.any(String) })
  return output.operationId
}

describe('file edit store profile binding', () => {
  it('restores another conversation and keeps retained requests discoverable after their run locator is removed', async () => {
    const profile = selectProfile('cross-conversation')
    const workspace = join(home, 'cross-conversation-workspace')
    await mkdir(workspace)
    const storage = AgentStorage.openNative(profile)
    try {
      const source = storage.createThread(), target = storage.createThread()
      const sourceDatabase = storage.conversationForThread(source.id)
      const targetDatabase = storage.conversationForThread(target.id)
      const sourceRun = randomUUID(), targetRun = randomUUID()
      sourceDatabase.runs.createRun({ threadId: source.id, runId: sourceRun, operation: 'agent', message: { id: `${sourceRun}:input`, value: { id: `${sourceRun}:input`, kind: 'user', content: 'Edit file', context: { runId: sourceRun } } } })
      targetDatabase.runs.createRun({ threadId: target.id, runId: targetRun, operation: 'agent', message: { id: `${targetRun}:input`, value: { id: `${targetRun}:input`, kind: 'user', content: 'Edit file', context: { runId: targetRun } } } })
      storage.refreshConversation(source.id)
      storage.refreshConversation(target.id)
      const sourceStore = sourceDatabase.resources.fileEditStore, targetStore = targetDatabase.resources.fileEditStore
      const operation = await write(writeTool(workspace, sourceRun, sourceStore), sourceRun, 'cross.txt')
      await sourceStore.deleteFileEditRecordsForRequest(sourceRun, [operation])
      expect((await targetStore.listRetainedEditRecords()).map(record => record.operationId)).toEqual([operation])
      expect(targetStore.editRecordDir(sourceRun, operation)).toBe(sourceStore.editRecordDir(sourceRun, operation))
      let blockedDeletion = false
      const inverse = await runWithCurrentAgentToolEffect({
        identity: effectIdentity(targetRun),
        isUnarmed: () => true,
        persistFileChange: (record, observed) => targetDatabase.resources.fileChanges.persist(record, observed || record.requestId !== targetRun),
        arm: () => {
          expect(() => storage.beginConversationDeletion(source.id)).toThrow('file recovery material is in use')
          blockedDeletion = true
        }
      }, () => targetStore.restorePatch(operation, sourceRun, targetRun, async () => {}, { operationId: randomUUID() }))
      expect(blockedDeletion).toBe(true)
      expect(inverse?.requestId).toBe(targetRun)
      expect(await pathExists(join(workspace, 'cross.txt'))).toBe(false)
      expect(await pathExists(targetStore.editRecordDir(targetRun, inverse!.operationId))).toBe(true)
      await targetStore.finalizePatchRestore(operation, sourceRun, async () => {}, {
        inverse: { requestId: targetRun, operationId: inverse!.operationId }
      })
      expect((await sourceStore.loadOperationRecord(operation, sourceRun)).transaction.recovery?.state).toBe('complete')

      // A retained request with no run locator remains owned by its physical conversation.
      const truncatedRun = randomUUID()
      const retainedOperation = await write(writeTool(workspace, truncatedRun, sourceStore), truncatedRun, 'retained.txt')
      await sourceStore.deleteFileEditRecordsForRequest(truncatedRun, [retainedOperation])
      expect(storage.conversationForRun(truncatedRun)).toBeUndefined()
      expect((await targetStore.loadOperationRecord(retainedOperation, truncatedRun)).operationId).toBe(retainedOperation)
      expect((await targetStore.listRetainedEditRecords()).map(record => record.operationId)).toContain(retainedOperation)
      await storage.removeConversation(source.id)
      await expect(targetStore.loadOperationRecord(retainedOperation, truncatedRun)).rejects.toThrow('not found')
    } finally { storage.close() }
  })

  it('uses configuration applied after imports and binds each created tool group to its profile', async () => {
    const workspace = join(home, 'workspace')
    await mkdir(workspace)
    const requestId = randomUUID()
    const first = selectProfile('first')
    const firstStore = new FileEditStore(getFileEditRecordsDir('conversation'))
    const firstTool = writeTool(workspace, requestId, firstStore)
    const second = selectProfile('second')
    const secondStore = new FileEditStore(getFileEditRecordsDir('conversation'))
    const secondTool = writeTool(workspace, requestId, secondStore)

    const firstOperation = await write(firstTool, requestId, 'first.txt')
    const secondOperation = await write(secondTool, requestId, 'second.txt')
    expect(await readFile(join(workspace, 'first.txt'), 'utf8')).toBe('first.txt')
    expect(await readFile(join(workspace, 'second.txt'), 'utf8')).toBe('second.txt')
    expect((await firstStore.loadOperationRecord(firstOperation, requestId)).operationId).toBe(firstOperation)
    expect(await firstStore.listEditRecordsForRequest(requestId)).toHaveLength(1)
    expect(secondStore.editRecordsDir(requestId)).toBe(join(second, 'db', 'projects', 'default-workspace', 'conversations', 'conversation', 'file_edits', requestId))
    expect(secondStore.editRecordDir(requestId, secondOperation)).toBe(join(second, 'db', 'projects', 'default-workspace', 'conversations', 'conversation', 'file_edits', requestId, secondOperation))
    expect((await secondStore.listEditRecordsForRequest(requestId)).map(record => record.operationId)).toEqual([secondOperation])
    expect(await pathExists(join(first, 'db', 'projects', 'default-workspace', 'conversations', 'conversation', 'file_edits', requestId, secondOperation))).toBe(false)

    const secondRead = secondStore.loadOperationRecord(secondOperation, requestId)
    selectProfile('first')
    expect((await secondRead).operationId).toBe(secondOperation)
    expect((await firstStore.loadOperationRecord(firstOperation, requestId)).operationId).toBe(firstOperation)
    await firstStore.deleteFileEditRecordsForRequest(requestId, [firstOperation])
    expect((await firstStore.listRetainedEditRecords()).map(record => record.operationId)).toEqual([firstOperation])
    selectProfile('second')
    expect(await secondStore.listRetainedEditRecords()).toEqual([])
    await secondStore.deleteFileEditRecordsForRequest(requestId)
    expect(await secondStore.listEditRecordsForRequest(requestId)).toEqual([])
    expect((await firstStore.listEditRecordsForRequest(requestId)).map(record => record.operationId)).toEqual([firstOperation])
    expect(await pathExists(join(home, '.galeAnas', 'file_edits'))).toBe(false)
  })

  it('keeps explicit stores and pending cleanup on their captured roots after another profile is selected', async () => {
    const workspace = join(home, 'cleanup-workspace')
    await mkdir(workspace)
    const requestId = randomUUID()
    selectProfile('cleanup-owner')
    const ownerStore = new FileEditStore(getFileEditRecordsDir('conversation'))
    const ownerTool = writeTool(workspace, requestId, ownerStore)
    const explicitStore = new FileEditStore(join(home, 'explicit-records'))
    const explicitTool = writeTool(workspace, requestId, explicitStore)
    const ownerOperation = await write(ownerTool, requestId, 'owner.txt')

    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { started = resolve })
    const snapshot = withApplicationDataSnapshot(async () => { started(); await gate })
    await entered
    const cleanup = ownerStore.deleteFileEditRecordsForRequest(requestId)
    selectProfile('cleanup-other')
    release()
    await snapshot
    await cleanup
    expect(await ownerStore.listEditRecordsForRequest(requestId)).toEqual([])
    expect(await pathExists(ownerStore.editRecordDir(requestId, ownerOperation))).toBe(false)
    expect(await readFile(join(workspace, 'owner.txt'), 'utf8')).toBe('owner.txt')

    const explicitOperation = await write(explicitTool, requestId, 'explicit.txt')
    expect((await explicitStore.loadOperationRecord(explicitOperation, requestId)).operationId).toBe(explicitOperation)
    expect(await new FileEditStore(getFileEditRecordsDir('conversation')).listEditRecordsForRequest(requestId)).toEqual([])
  })
})
