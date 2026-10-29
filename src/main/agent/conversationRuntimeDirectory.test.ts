import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentStorage } from './agentStorage'
import { NativeRunHost, type NativeRunContext, type NativeRunInstance } from './nativeRunHost'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { ManagedCallService } from './managedCallService'
import { ConversationRuntimeDirectory } from './conversationRuntimeDirectory'
import { getAgentConversationDatabaseFile } from '../config/dataDir'
import type { AgentRunSubmissionExecutionInput } from './agentRunInput'
import { withConversationLeaseScope } from './agentConversationLease'
import { getProject } from '../projectStore'

vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
vi.mock('../projectStore', () => ({
  getProject: vi.fn(async (id: string) => ({ id, kind: 'workspace', sourceFolders: [] })),
  deleteProjectWithThreads: vi.fn(async (_id: string, _threads: string[], commit: (apply: () => void) => void) => commit(() => {}))
}))

class Directory extends ConversationRuntimeDirectory<NativeConversationDatabase, NativeRunHost> {
  submit(input: AgentRunSubmissionExecutionInput, create: (context: NativeRunContext) => Promise<NativeRunInstance>) {
    return this.routeSubmission(input, host => host.submitRunWithAttachments(input, create))
  }
}
async function fixture(onCreate?: (host: NativeRunHost) => void) {
  const root = await mkdtemp(join(tmpdir(), 'anas-native-directory-')), storage = AgentStorage.openNative(root)
  const directory = new Directory(storage, {
    create: database => {
      const host = new NativeRunHost(database, new ManagedCallService(database.managed, database.results), { push: () => {} })
      onCreate?.(host)
      return host
    },
    unresolvedThreads: database => database.managed.listThreadIdsWithUnresolvedManagedCalls(),
    startupCleanup: runtime => runtime.cleanupResources()
  })
  return { root, storage, directory,
    async close() { await directory.shutdown(); storage.close(); await rm(root, { recursive: true, force: true }) } }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

it('keeps project lookup leased and stops creation when shutdown starts before lookup finishes', async () => {
  const h = await fixture(), gate = deferred(), entered = deferred(), threadId = randomUUID()
  const project = await getProject('project-a')
  vi.mocked(getProject).mockImplementationOnce(async () => { entered.resolve(); await gate.promise; return project })
  const create = vi.fn(async (): Promise<NativeRunInstance> => { throw new Error('Unexpected model request') })
  try {
    const submitted = h.directory.submit({ threadId, runId: randomUUID(), submissionId: randomUUID(), newThread: { projectId: 'project-a' }, text: 'Task' }, create)
    const rejected = expect(submitted).rejects.toThrow('shutting down')
    await entered.promise
    await expect(h.directory.deleteProject('project-a')).rejects.toThrow('still being created')
    expect(await h.directory.shutdown({ timeoutMs: 0 })).toMatchObject({ drained: false })
    gate.resolve(); await rejected
    expect(await h.directory.shutdown()).toMatchObject({ drained: true })
    expect(h.storage.openedConversations()).toEqual([])
    expect(existsSync(getAgentConversationDatabaseFile(threadId, h.root, 'project-a'))).toBe(false)
    expect(create).not.toHaveBeenCalled()
  } finally { gate.resolve(); await h.close() }
})

it('shares native connection leases and idle reclamation with the existing product directory', async () => {
  const h = await fixture(), gate = deferred(), held = h.storage.createThread()
  const host = h.directory.forThread(held.id)
  const read = withConversationLeaseScope(async () => {
    const database = h.directory.databaseForThread(held.id)
    await gate.promise
    return database.getThread(held.id)
  })
  try {
    for (let index = 0; index < 35; index++) h.directory.forThread(h.storage.createThread().id)
    h.directory.trimIdleConversations()
    expect(h.storage.openedConversations()).toHaveLength(33)
    expect(h.directory.forThread(held.id)).toBe(host)
    await expect(h.directory.deleteThread(held.id)).rejects.toThrow('conversation operation is in progress')
    await expect(h.directory.compactDatabase()).rejects.toThrow('requires Agent runs to finish')
    gate.resolve(); expect((await read)?.id).toBe(held.id)
    h.directory.trimIdleConversations()
    expect(h.storage.openedConversations()).toHaveLength(32)
    await h.directory.compactDatabase()
    expect(h.directory.forThread(held.id)).not.toBe(host)
    expect(h.directory.databaseForThread(held.id).getThread(held.id)?.id).toBe(held.id)
  } finally { gate.resolve(); await read; await h.close() }
}, 15_000)

it('waits for the actual native executor before removing its conversation and preserves another owner', async () => {
  const h = await fixture(), gate = deferred(), entered = deferred(), runId = randomUUID(), threadId = randomUUID()
  const create = vi.fn(async (context: NativeRunContext): Promise<NativeRunInstance> => {
    entered.resolve(); await gate.promise
    expect(context.signal.aborted).toBe(true)
    throw new Error('Assembly stopped')
  })
  try {
    const saved = await h.directory.submit({ threadId, runId, submissionId: randomUUID(), newThread: { projectId: 'project-a' }, text: 'Task' }, create)
    await entered.promise
    const retained = h.storage.createThread({ projectId: 'project-b' }), file = getAgentConversationDatabaseFile(threadId, h.root, 'project-a')
    const deleting = h.directory.deleteThread(threadId)
    await vi.waitFor(() => expect(h.storage.isConversationDeleting(threadId)).toBe(true))
    expect(existsSync(file)).toBe(true)
    expect(() => h.directory.forThread(threadId)).toThrow('deletion is pending')
    gate.resolve()
    expect((await saved.handle!.completed).status).toBe('cancelled')
    await deleting
    expect(existsSync(file)).toBe(false)
    expect(h.storage.getThread(threadId)).toBeNull()
    expect(h.directory.databaseForThread(retained.id).getThread(retained.id)?.projectId).toBe('project-b')
  } finally { gate.resolve(); await h.close() }
})

it('does not report shutdown drained while a plain reader or memory write still holds a connection', async () => {
  const h = await fixture(), readGate = deferred(), writeGate = deferred(), thread = h.storage.createThread()
  const reading = withConversationLeaseScope(async () => {
    const database = h.directory.databaseForThread(thread.id)
    await readGate.promise
    return database.getThread(thread.id)
  })
  const writing = h.directory.useStorage(async storage => {
    await writeGate.promise
    return storage.memoryStore.saveMemory({ scope: 'global', kind: 'fact', content: 'Saved before close', keywords: [], importance: 3 }, { origin: 'user' })
  })
  try {
    await expect(h.directory.shutdown({ timeoutMs: -1 })).rejects.toThrow('non-negative safe integer')
    expect(h.directory.databaseForThread(thread.id).getThread(thread.id)?.id).toBe(thread.id)
    expect(await h.directory.shutdown({ timeoutMs: 0 })).toEqual({ drained: false, lingeringRunIds: [], lingeringCallIds: [] })
    readGate.resolve(); expect((await reading)?.id).toBe(thread.id)
    expect(await h.directory.shutdown({ timeoutMs: 0 })).toMatchObject({ drained: false })
    writeGate.resolve(); expect((await writing).content).toBe('Saved before close')
    expect(await h.directory.shutdown()).toEqual({ drained: true, lingeringRunIds: [], lingeringCallIds: [] })
  } finally { readGate.resolve(); writeGate.resolve(); await Promise.all([reading, writing]); await h.close() }
})

it('keeps project deletion out of a new native submission and discards only its empty failed directory', async () => {
  const gate = deferred(), entered = deferred(), threadId = randomUUID()
  const h = await fixture(host => {
    vi.spyOn(host, 'submitRunWithAttachments').mockImplementation(async () => {
      entered.resolve(); await gate.promise; throw new Error('Archive failed')
    })
  })
  const create = vi.fn(async (): Promise<NativeRunInstance> => { throw new Error('Unexpected model request') })
  try {
    const submitted = h.directory.submit({ threadId, runId: randomUUID(), submissionId: randomUUID(), newThread: { projectId: 'project-a' }, text: 'Task' }, create)
    const rejected = expect(submitted).rejects.toThrow('Archive failed')
    await entered.promise
    await expect(h.directory.deleteProject('project-a')).rejects.toThrow('still being created')
    gate.resolve(); await rejected
    expect(h.storage.openedConversations()).toEqual([])
    expect(existsSync(getAgentConversationDatabaseFile(threadId, h.root, 'project-a'))).toBe(false)
    expect(create).not.toHaveBeenCalled()
  } finally { gate.resolve(); await h.close() }
})
