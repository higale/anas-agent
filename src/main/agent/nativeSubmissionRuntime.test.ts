import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { AgentRuntimeEvent } from '../../shared/agentTypes'
import type { AgentRunSubmissionExecutionInput } from './agentRunInput'
import { conversationExecution, type ConversationExecutionServices } from '../../runtime/conversationExecution'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import type { ExecutionToolCall } from '../../runtime/executionState'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { NativeRunHost } from './nativeRunHost'
import { ManagedCallService } from './managedCallService'
import { SqliteMemoryStore } from './memoryStore'
import { FileEditStore } from '../fileEditStore'
import { getProject } from '../projectStore'

vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
vi.mock('../projectStore', () => ({ getProject: vi.fn(async () => ({ kind: 'workspace', accessMode: 'full_access' })) }))
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function fixture(configure?: (services: ConversationExecutionServices) => void) {
  const root = mkdtempSync(join(tmpdir(), 'anas-native-submission-')), global = new Database(':memory:')
  const file = join(root, 'conversation.sqlite'), attachmentRoot = join(root, 'attachments'), events: AgentRuntimeEvent[] = []
  const options = { attachmentRoot, memoryStore: new SqliteMemoryStore(global), fileEditStore: new FileEditStore(join(root, 'file_edits')) }
  let database = NativeConversationDatabase.open(file, options)
  let host = new NativeRunHost(database, new ManagedCallService(database.managed, database.results), { push: event => events.push(event) })
  let requests = 0
  const create = vi.fn(async () => {
    const services: ConversationExecutionServices = { store: database.runs.store, enter: database.execution.enter,
      prepareModel: async state => ({ kind: 'model', invoke: async () => ({
        message: { id: `${state.runId}:answer`, value: { kind: 'assistant', content: `Answer ${++requests}`, context: { runId: state.runId } } },
        calls: [], context: { ...state.context, modelCalls: state.context.modelCalls + 1 } }) }),
      afterModel: async () => ({ kind: 'complete' }), prepareTools: async () => ({ calls: [] }),
      executeTool: async () => { throw new Error('No tool expected') }, directions: async () => [], drain: async () => {}, retry: { maxRetries: 0 } }
    configure?.(services)
    return { execution: conversationExecution(services), dispose: async () => {} }
  })
  const input = (): AgentRunSubmissionExecutionInput => {
    const source = join(root, `${randomUUID()}.txt`); writeFileSync(source, 'Submission attachment')
    return { threadId: randomUUID(), runId: randomUUID(), submissionId: randomUUID(), newThread: { projectId: 'project', modelConfigId: 'chosen-model' },
      text: 'Expanded request', displayText: 'Visible request', content: [{ type: 'image', data: 'fixture', mimeType: 'image/png' }],
      attachments: [{ path: source, name: 'input.txt', mimeType: 'text/plain', kind: 'text', size: 21, contextPolicy: 'conversation' }] }
  }
  return { root, input, create, events, get database() { return database }, get host() { return host }, get requests() { return requests },
    async reopen() { await host.waitForIdle(); database.close(); database = NativeConversationDatabase.open(file, options);
      host = new NativeRunHost(database, new ManagedCallService(database.managed, database.results), { push: event => events.push(event) }) },
    async close() { await host.waitForIdle(); database.validate(); database.close(); global.close(); rmSync(root, { recursive: true, force: true }) }
  }
}

it('finishes an accepted submission during shutdown without dispatching its saved input', async () => {
  const h = fixture(), pendingProject = deferred(), input = h.input()
  vi.mocked(getProject).mockImplementationOnce(async () => {
    await pendingProject.promise
    return { kind: 'workspace', accessMode: 'full_access' } as Awaited<ReturnType<typeof getProject>>
  })
  try {
    const submitting = h.host.submitRunWithAttachments(input, h.create)
    expect(h.host.hasLiveWork()).toBe(true)
    expect(await h.host.shutdown({ timeoutMs: 0 })).toEqual({ drained: false, lingeringRunIds: [], lingeringCallIds: [] })
    expect(h.host.retireIfIdle()).toBe(false)
    pendingProject.resolve()
    const saved = await submitting
    expect(saved.userMessage?.attachments).toHaveLength(1)
    expect((await saved.handle!.completed).status).toBe('cancelled')
    expect(await h.host.shutdown()).toEqual({ drained: true, lingeringRunIds: [], lingeringCallIds: [] })
    expect(h.create).not.toHaveBeenCalled()
    expect(h.requests).toBe(0)
    await h.reopen()
    expect(h.host.getRunSubmission(input.submissionId)?.run.status).toBe('cancelled')
    expect(h.host.recoverRun(input.threadId, h.create)).toBeUndefined()
  } finally { pendingProject.resolve(); await h.close() }
})

it('holds the connection while an accepted queued attachment is archived during shutdown', async () => {
  const h = fixture(), input = h.input()
  h.database.createThread({}, input.threadId)
  try {
    const queued = h.host.enqueueQueuedInput({ id: input.submissionId, threadId: input.threadId, text: 'Queued', attachments: input.attachments })
    expect(h.host.hasLiveWork()).toBe(true)
    expect(h.host.retireIfIdle()).toBe(false)
    const shutdown = h.host.shutdown()
    const saved = await queued
    expect(readFileSync(saved.attachments[0].path, 'utf8')).toBe('Submission attachment')
    expect(await shutdown).toEqual({ drained: true, lingeringRunIds: [], lingeringCallIds: [] })
    await h.reopen()
    expect(h.host.listQueuedInputs()[0].attachments).toEqual(saved.attachments)
  } finally { await h.close() }
})

it.each([
  { projectMode: undefined, override: undefined, expected: 'smart_approval' },
  { projectMode: 'full_access', override: undefined, expected: 'full_access' },
  { projectMode: 'strict_approval', override: undefined, expected: 'strict_approval' },
  { projectMode: 'full_access', override: 'smart_approval', expected: 'smart_approval' },
  { projectMode: 'smart_approval', override: 'full_access', expected: 'full_access' }
] as const)('deduplicates submissions and preserves project permission $projectMode with override $override', async ({ projectMode, override, expected }) => {
  const h = fixture(), input = h.input(), assembly = deferred()
  const project = await getProject('project')
  if (project.kind !== 'workspace' || !input.newThread) throw new Error('Expected a new workspace conversation')
  vi.mocked(getProject).mockResolvedValueOnce({ ...project, accessMode: projectMode })
  input.newThread = { ...input.newThread, accessMode: override }
  const duplicateInput = { ...input, threadId: randomUUID(), runId: randomUUID(), text: 'Duplicate text', newThread: { ...input.newThread, accessMode: 'strict_approval' as const } }
  const create = async () => { await assembly.promise; return h.create() }
  try {
    const first = h.host.submitRunWithAttachments(input, create)
    const duplicate = h.host.submitRunWithAttachments(duplicateInput, create)
    const [submission, repeated] = await Promise.all([first, duplicate])
    expect(repeated.run.id).toBe(input.runId)
    expect(submission.thread).toMatchObject({ modelConfigId: 'chosen-model', accessMode: expected })
    expect(repeated.thread.id).toBe(input.threadId)
    expect(repeated.userMessage).toEqual(submission.userMessage)
    expect(submission.userMessage).toMatchObject({ id: `${input.runId}:input`, role: 'user', attachments: [{ name: 'input.txt' }] })
    expect(JSON.stringify(submission.userMessage)).toContain('Visible request')
    expect(JSON.stringify(submission.userMessage)).toContain('fixture')
    expect(h.requests).toBe(0)
    const archived = submission.userMessage!.attachments![0].path
    expect(readFileSync(archived, 'utf8')).toBe('Submission attachment')
    await expect(h.host.submitRunWithAttachments({ ...input, submissionId: randomUUID(), runId: randomUUID(), newThread: undefined }, create)).rejects.toThrow()
    assembly.resolve(); expect((await submission.handle!.completed).status).toBe('completed'); await submission.handle!.drained
    expect(h.requests).toBe(1)
    expect(h.events.find(event => event.type === 'run_started')).toMatchObject({ newUserTurn: true, userMessage: { attachments: [{ path: archived }] } })
    await h.reopen()
    const persisted = await h.host.submitRunWithAttachments(duplicateInput, h.create)
    expect(persisted.run.id).toBe(input.runId)
    expect(persisted.thread).toMatchObject({ id: input.threadId, accessMode: expected })
    expect(persisted.handle).toBeUndefined()
    expect(h.database.resources.getThread(duplicateInput.threadId)).toBeNull()
    expect(h.database.messages.activities.getRun(duplicateInput.runId)).toBeNull()
    expect(h.requests).toBe(1)
    const next = await h.host.submitRunWithAttachments({ ...input, newThread: undefined, runId: randomUUID(), submissionId: randomUUID(), attachments: [] }, h.create)
    await next.handle!.completed; await next.handle!.drained
    expect(h.requests).toBe(2)
    expect(h.host.readSnapshot(input.threadId).messages).toHaveLength(4)
  } finally { assembly.resolve(); await h.close() }
})

it('retains committed input after assembly failure and recovers it once after reopen without adding a user turn event', async () => {
  const h = fixture(), input = h.input()
  try {
    const failed = await h.host.submitRunWithAttachments(input, async () => { throw new Error('Model configuration temporarily unavailable') })
    expect((await failed.handle!.completed).status).toBe('running'); await failed.handle!.drained
    const archived = failed.userMessage!.attachments![0].path
    expect(existsSync(archived)).toBe(true)
    await h.reopen()
    const repeated = await h.host.submitRunWithAttachments(input, h.create)
    expect(repeated.run.id).toBe(input.runId); expect(repeated.handle).toBeUndefined(); expect(h.requests).toBe(0)
    expect(h.host.getRunSubmission(input.submissionId)?.userMessage?.attachments?.[0].path).toBe(archived)
    const recovered = h.host.recoverRun(input.threadId, h.create)!
    expect((await recovered.completed).status).toBe('completed'); await recovered.drained
    expect(h.requests).toBe(1)
    expect(h.events.filter(event => event.type === 'run_started').at(-1)).toMatchObject({ newUserTurn: false, userMessage: { attachments: [{ path: archived }] } })
    expect(h.host.recoverRun(input.threadId, h.create)).toBeUndefined()
    expect(h.host.readSnapshot(input.threadId).messages.filter(message => message.role === 'user')).toHaveLength(1)
  } finally { await h.close() }
})

it('does not create a thread or saved input when attachment archival fails, and allows the same submission to retry', async () => {
  const h = fixture(), input = h.input()
  try {
    const original = input.attachments![0].path
    input.attachments![0].path = join(h.root, 'missing.txt')
    await expect(h.host.submitRunWithAttachments(input, h.create)).rejects.toThrow()
    expect(h.host.getRunSubmission(input.submissionId)).toBeUndefined()
    expect(h.database.resources.getThread(input.threadId)).toBeNull()
    input.attachments![0].path = original
    input.newThread!.accessMode = 'strict_approval'
    const retried = await h.host.submitRunWithAttachments(input, h.create)
    await retried.handle!.completed; await retried.handle!.drained
    expect(retried.thread.accessMode).toBe('strict_approval')
    expect(h.requests).toBe(1)
  } finally { await h.close() }
})

it.each([false, true])('applies queued directions only with the committed batch and keeps queue ownership on rollback (%s)', async rollback => {
  const entered = deferred(), release = deferred()
  const h = fixture(services => {
    const original = services.prepareModel
    services.prepareModel = async (state, request, observer) => {
      if (state.context.modelCalls) return original(state, request, observer)
      const call: ExecutionToolCall = { id: 'read', providerCallId: 'provider-read', name: 'read_file', args: {},
        artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, randomUUID()])) as ExecutionToolCall['artifacts'] }
      return { kind: 'model', invoke: async () => ({ message: { id: 'tool-request', value: { kind: 'assistant', content: '',
        calls: [{ id: 'provider-read', name: 'read_file', args: {} }], context: { runId: state.runId } } }, calls: [call], context: { ...state.context, modelCalls: 1 } }) }
    }
    services.prepareTools = async state => ({ calls: state.calls.map(call => ({ callId: call.id, args: call.args })) })
    services.executeTool = async call => { entered.resolve(); await release.promise; return { kind: 'result',
      message: { id: 'read-result', value: { kind: 'tool', resultFor: call.providerCallId, content: 'File content' } } } }
    services.directions = state => h.database.runs.directions(state)
  })
  const sql = new Database(join(h.root, 'conversation.sqlite'))
  try {
    const input = h.input(); h.database.runs.createThread({}, input.threadId); input.newThread = undefined
    const queued = await h.host.enqueueQueuedInput({ id: randomUUID(), threadId: input.threadId, text: '  Expanded direction  ', displayText: '  Display direction  ', attachments: input.attachments })
    const withdrawn = await h.host.enqueueQueuedInput({ id: randomUUID(), threadId: input.threadId, text: 'Withdraw me' })
    const steer = { threadId: input.threadId, runId: input.runId, queuedInputId: queued.id, text: queued.text, displayText: queued.displayText,
      attachments: queued.attachments.map(item => ({ path: item.path, name: item.name, size: item.size, kind: item.kind,
        mimeType: item.mimeType, contextPolicy: item.contextPolicy, textTruncated: item.truncated })) }
    const submission = await h.host.submitRunWithAttachments({ ...input, attachments: [] }, h.create); await entered.promise
    await expect(h.host.steerRun({ ...steer, text: 'Changed after enqueue' })).rejects.toThrow('changed from its saved queued message')
    expect(await h.host.steerRun(steer)).toBe(true)
    rmSync(input.attachments![0].path)
    expect(await h.host.steerRun(steer)).toBe(true)
    expect(await h.host.steerRun({ ...input, queuedInputId: withdrawn.id, text: withdrawn.text, displayText: undefined, attachments: [] })).toBe(true)
    expect(await h.host.removeSteer({ ...input, queuedInputId: withdrawn.id })).toBe(true)
    expect(h.events.some(event => event.type === 'direction_applied')).toBe(false)
    if (rollback) sql.exec("CREATE TRIGGER reject_queue_commit BEFORE DELETE ON agent_queued_inputs BEGIN SELECT RAISE(ABORT,'queue commit failed'); END")
    release.resolve()
    expect((await submission.handle!.completed).status).toBe(rollback ? 'failed' : 'completed'); await submission.handle!.drained
    expect(existsSync(queued.attachments[0].path)).toBe(true)
    const directions = h.events.filter(event => event.type === 'direction_applied')
    if (rollback) {
      expect(directions).toEqual([])
      expect(h.host.listQueuedInputs().map(item => item.id)).toContain(queued.id)
      expect(h.database.resources.listAttachmentsForMessages(input.threadId, [`${input.runId}:direction:${queued.id}`])).toEqual([])
      sql.exec('DROP TRIGGER reject_queue_commit')
    } else {
      expect(directions).toMatchObject([{ queuedInputId: queued.id, message: { directionAfterToolCallIds: ['read'], content: [{ type: 'text', text: 'Display direction' }],
        attachments: [{ path: queued.attachments[0].path }] } }])
      expect(directions).toHaveLength(1)
      expect(h.host.listQueuedInputs().map(item => item.id)).toEqual([withdrawn.id])
      expect(h.database.runs.store.readHistory(input.threadId)!.messages.find(message => message.id === `${input.runId}:direction:${queued.id}`)?.value.content).toBe('Expanded direction')
      expect(h.host.readSnapshot(input.threadId).activities[0].models).toHaveLength(2)
      const before = h.events.length
      await h.reopen()
      expect(h.host.recoverRun(input.threadId, h.create)).toBeUndefined()
      expect(h.events.slice(before).some(event => event.type === 'direction_applied')).toBe(false)
    }
    expect(await h.host.steerRun({ ...steer, queuedInputId: withdrawn.id })).toBe(false)
  } finally { release.resolve(); sql.close(); await h.close() }
})

it('keeps queue attachment deletion atomic and retries an unfinished acknowledgement after reopen', async () => {
  const h = fixture(), input = h.input(), sql = new Database(join(h.root, 'conversation.sqlite'))
  try {
    h.database.runs.createThread({}, input.threadId)
    const id = randomUUID(), [queued, duplicate] = await Promise.all([
      h.host.enqueueQueuedInput({ id, threadId: input.threadId, text: 'Queued', attachments: input.attachments }),
      h.host.enqueueQueuedInput({ id, threadId: input.threadId, text: 'Queued', attachments: input.attachments })])
    expect(duplicate.attachments).toEqual(queued.attachments)
    expect(h.requests).toBe(0)
    sql.exec("CREATE TRIGGER reject_queue_delete BEFORE DELETE ON agent_queued_inputs BEGIN SELECT RAISE(ABORT,'queue deletion failed'); END")
    await expect(h.host.removeQueuedInput(input.threadId, id)).rejects.toThrow('queue deletion failed')
    expect(h.host.listQueuedInputs()).toHaveLength(1)
    expect(h.database.resourceCleanup.listAttachmentFileCleanup()).toEqual([])
    expect(existsSync(queued.attachments[0].path)).toBe(true)
    sql.exec('DROP TRIGGER reject_queue_delete')
    sql.exec("CREATE TRIGGER reject_cleanup_ack BEFORE DELETE ON agent_attachment_file_cleanup_outbox BEGIN SELECT RAISE(ABORT,'cleanup acknowledgement failed'); END")
    expect(await h.host.removeQueuedInput(input.threadId, id)).toBe(true)
    expect(h.host.listQueuedInputs()).toEqual([])
    expect(h.database.resourceCleanup.listAttachmentFileCleanup()).toHaveLength(1)
    await h.reopen()
    sql.exec('DROP TRIGGER reject_cleanup_ack'); await h.host.cleanupResources()
    expect(h.database.resourceCleanup.listAttachmentFileCleanup()).toEqual([])
    expect(existsSync(queued.attachments[0].path)).toBe(false)
  } finally { sql.close(); await h.close() }
})

it.each([false, true])('accepts a fresh user turn after terminal preparation failure without replaying the failed input (reopen=%s)', async reopen => {
  let failedRunId = '', failedPreparations = 0
  const h = fixture(services => {
    const prepare = services.prepareModel
    services.prepareModel = async (...args) => {
      if (args[0].runId === failedRunId) { failedPreparations += 1; throw new Error('Old input failed') }
      return prepare(...args)
    }
  })
  const input = { ...h.input(), text: 'old', displayText: 'old', content: undefined, attachments: [] }
  failedRunId = input.runId
  try {
    const failed = await h.host.submitRunWithAttachments(input, h.create)
    expect((await failed.handle!.completed).status).toBe('failed'); await failed.handle!.drained
    expect(failedPreparations).toBe(1); expect(h.requests).toBe(0)
    if (reopen) await h.reopen()
    const fresh = await h.host.submitRunWithAttachments({ ...input, newThread: undefined, text: 'fresh', displayText: 'fresh',
      runId: randomUUID(), submissionId: randomUUID() }, h.create)
    expect((await fresh.handle!.completed).status).toBe('completed'); await fresh.handle!.drained
    expect(failedPreparations).toBe(1); expect(h.requests).toBe(1)
    const messages = h.database.runs.store.load(input.threadId)!.messages
    expect(messages.filter(message => message.value.kind === 'user').map(message => message.id)).toEqual([failed.userMessage!.id, fresh.userMessage!.id])
    expect(messages).toHaveLength(3)
    expect(h.database.readModel.getRun(failedRunId)).toMatchObject({ status: 'failed', error: 'Old input failed' })
  } finally { await h.close() }
})
