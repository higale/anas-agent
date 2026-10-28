import { toolPackageFixture, selectedTools } from '../../test/toolPackageFixture'
import { customToolDefaults } from '@shared/customTools'
import { defaultWorkspaceProject, previewConfig } from '../../test/agentConfigurationFixture'
import { NativeSubagentService } from './nativeSubagentService'
import { NativeRuntimeCoordinator } from './nativeRuntimeCoordinator'
import { AgentStorage } from './agentStorage'
import { codeReviewSnapshotId } from '../../runtime/codeReviewReport'
import type { NativeRunSubmission } from './nativeRunHost'
import { NativeRunHost, type NativeRunContext } from './nativeRunHost'
import { captureAgentModelRequest } from './conversationPreview'
import NativeDatabase from 'better-sqlite3'
import { createConversationInstance, type ConversationInstanceOwner } from './conversationInstance'
import { initializeNativeConversationStorage } from './nativeDatabaseSchema'
import { validateNativeExecutionStorage } from './nativeStorageValidation'
import { ConversationResourceReader } from './conversationResourceReader'
import { SqliteMemoryStore } from './memoryStore'
import { FileChangeLedger } from './fileChangeLedger'
import { FileEditStore } from '../fileEditStore'
import { ManagedCallStore } from './managedCallStore'
import { NativeManagedResults } from './nativeManagedResults'
import { NativeRunOwner } from './nativeRunOwner'
import { NativeMessageProjection } from './nativeMessageProjection'
import { QueuedInputStore } from './queuedInputStore'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { NativeMessageReader } from './nativeMessageReader'
import { archiveAgentAttachments } from './agentAttachmentStore'
import type { RunObserver } from '../../runtime/runExecution'

import * as toolsStore from '../toolsStore'
vi.mock('../toolsStore', async importOriginal => ({ ...await importOriginal<typeof import('../toolsStore')>(), listToolSnapshot: vi.fn(async () => ({ roots: [], tools: [] })) }))

import { defaultCapabilities } from '@shared/agentCapabilities'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createPatch } from 'diff'
import { codeReviewPrompt } from './codeReview'

import type { AgentRuntimeEvent } from '@shared/agentTypes'

import { ManagedCallService } from './managedCallService'

const testPaths = vi.hoisted(() => ({ root: '' }))
vi.mock('../config/dataDir', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config/dataDir')>(),
  getDataDir: () => testPaths.root,
  getConfigFile: (name: string) => join(testPaths.root, 'config', name),
  getSkillsDir: () => join(testPaths.root, 'skills'),
  getSystemSkillsDir: () => join(testPaths.root, 'skills/_system'),
  getSystemPluginsDir: () => join(testPaths.root, 'plugins/_system'),
  getSkillExamplesDir: () => join(testPaths.root, 'examples/skills')
}))
beforeAll(async () => { testPaths.root = await mkdtemp(join(tmpdir(), 'anas-native-product-')) })
afterAll(async () => { await rm(testPaths.root, { recursive: true, force: true }) })

const projectStoreMocks = vi.hoisted(() => ({
  getProject: vi.fn()
}))
const memoryStoreMocks = vi.hoisted(() => ({
  buildMemoryRulesPrompt: vi.fn()
}))
const languageStoreMocks = vi.hoisted(() => ({
  resolveConfiguredLanguage: vi.fn(async () => ({
    code: 'en',
    name: 'English',
    builtIn: true
  }))
}))
const appConfigMocks = vi.hoisted(() => ({
  getAppConfigSnapshot: vi.fn()
}))
vi.mock('../projectStore', () => ({
  getProject: projectStoreMocks.getProject
}))
vi.mock('./conversationMemory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./conversationMemory')>()
  return {
    ...actual,
    buildMemoryRulesPrompt: memoryStoreMocks.buildMemoryRulesPrompt
  }
})
vi.mock('../languageStore', () => ({
  resolveConfiguredLanguage: languageStoreMocks.resolveConfiguredLanguage
}))
vi.mock('../config/appConfig', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config/appConfig')>(),
  getAppConfigSnapshot: appConfigMocks.getAppConfigSnapshot
}))

describe('native product integration', () => {
beforeEach(() => {
    vi.mocked(toolsStore.listToolSnapshot).mockReset().mockResolvedValue({ roots: [], tools: [] })
    projectStoreMocks.getProject.mockReset().mockResolvedValue(defaultWorkspaceProject())
    memoryStoreMocks.buildMemoryRulesPrompt.mockReset().mockResolvedValue('')
    appConfigMocks.getAppConfigSnapshot.mockReset()
  })
it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    'runs %s through native product configuration, directory, review, compression and child assembly', async protocol => {
      const snapshot = previewConfig(); snapshot.providers[0].protocol = protocol
      appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
      const project = defaultWorkspaceProject()
      if (project.kind !== 'workspace') throw new Error('Expected workspace')
      project.sourceFolders = [testPaths.root]
      project.capabilities = { ...structuredClone(defaultCapabilities), environment: false, memory: false,
        skills: { mode: 'off', project: false, entries: [] }, customTools: { mode: 'off', project: false, entries: [] },
        subagents: { mode: 'default', names: [] }, toolMode: 'selected', tools: [], planning: false, backgroundTools: false }
      snapshot.subagents = [{ name: 'helper', index: 0, enabled: true, builtIn: false, description: 'Delegate work',
        systemPrompt: 'PRODUCT_CHILD_MARKER: complete only your assigned task.',
        capabilities: { ...structuredClone(project.capabilities), subagents: { mode: 'off', names: [] } } }]
      projectStoreMocks.getProject.mockImplementation(async id => id === 'simple-project' ? { ...project, id, kind: 'simple_chat' } : project)
      const root = join(testPaths.root, 'native-product-' + protocol), events: AgentRuntimeEvent[] = [], requests: Record<string, unknown>[] = []
      let mode: 'plain' | 'review' | 'delegate' = 'plain', parentRequests = 0, childRequests = 0, delegateRunId = ''
      const captured = { request: { kind: 'git' as const, projectId: project.id, sourceFolder: testPaths.root, scope: 'workspace' as const, version: 'a'.repeat(64) },
        projectId: project.id, capturedAt: '2026-10-27T00:00:00.000Z', description: 'Fixed review scope',
        files: [{ id: 'file', path: 'review.txt', patch: createPatch('review.txt', 'before\n', 'after\n'), before: [{ start: 1, end: 1 }], after: [{ start: 1, end: 1 }] }], limitations: [] }
      const review = { ...captured, id: codeReviewSnapshotId(captured) }
      const providerFetch = vi.fn<typeof fetch>(async (_url, init) => {
        const body = JSON.parse(String(init?.body)); requests.push(body)
        const child = JSON.stringify(body).includes('PRODUCT_CHILD_MARKER')
        let call: { id: string; name: string; args: Record<string, unknown> } | undefined
        if (mode === 'review') call = { id: 'report', name: 'anas_code_review_report', args: { scope_id: review.id, summary: 'Reviewed saved scope', findings: [], limitations: [] } }
        if (mode === 'delegate') {
          if (child) childRequests++
          else if (++parentRequests === 1) call = { id: 'start', name: 'start_subagent', args: { agent: 'helper', description: 'Independent child' } }
          else if (parentRequests === 2) {
            const [created] = runtime.databaseForThread(threadId).resources.listSubagentCallsForParentRun(delegateRunId)
            call = { id: 'wait', name: 'wait_subagent', args: { subagent_id: created.id } }
          }
        }
        const content = child ? 'Child completed' : 'Reply ' + requests.length
        if (protocol === 'anthropic_messages') return Response.json({ id: 'response', type: 'message', role: 'assistant', model: 'preview-model',
          content: call ? [{ type: 'tool_use', id: call.id, name: call.name, input: call.args }] : [{ type: 'text', text: content }],
          stop_reason: call ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } })
        if (protocol === 'openai_responses') return Response.json({ id: 'response', object: 'response', status: 'completed', model: 'preview-model',
          output: call ? [{ type: 'function_call', id: call.id + '-item', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args), status: 'completed' }]
            : [{ type: 'message', id: 'answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: content, annotations: [] }] }],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } })
        return Response.json({ id: 'response', object: 'chat.completion', created: 1, model: 'preview-model', choices: [{ index: 0,
          finish_reason: call ? 'tool_calls' : 'stop', message: { role: 'assistant', content: call ? '' : content,
            ...(call ? { tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : {}) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
      })
      const options = { prepareWorkspace: false, providerFetch }, sink = { push: (event: AgentRuntimeEvent) => { events.push(event) } }
      let storage = AgentStorage.openNative(root), runtime = new NativeRuntimeCoordinator(storage, sink, options)
      const threadId = randomUUID(), submissionId = randomUUID(), firstRunId = randomUUID(), secondRunId = randomUUID()
      const finish = async (saved: NativeRunSubmission) => {
        expect(saved.handle).toBeDefined()
        expect((await saved.handle!.completed).status).toBe('completed')
        await saved.handle!.drained
        expect(saved.handle!.diagnostics).toEqual([])
      }
      try {
        appConfigMocks.getAppConfigSnapshot.mockRejectedValueOnce(new Error('Configuration temporarily unavailable'))
        const first = await runtime.submitRunWithAttachments({ threadId, runId: firstRunId, submissionId,
          newThread: { projectId: project.id, modelConfigId: 'preview-model' }, text: 'First question' })
        expect((await first.handle!.completed).status).toBe('running')
        await first.handle!.drained
        expect(requests).toEqual([])
        expect(events.find(event => event.type === 'run_recovery_failed')).toMatchObject({ error: expect.stringContaining('Configuration temporarily unavailable') })
        await finish({ ...first, handle: runtime.recoverRun(threadId)?.handle })
        expect(storage.submissionOwner(submissionId)).toBe(threadId)
        const contextBefore = runtime.databaseForThread(threadId).runs.store.readHistory(threadId)!.revisionId
        const inspected = await runtime.getContextStatus(threadId)
        expect(inspected).toMatchObject({ modelConfigId: 'preview-model', maxContextTokens: 100_000 })
        expect(inspected!.currentContextTokens).toBeGreaterThan(0)
        expect(runtime.databaseForThread(threadId).runs.store.readHistory(threadId)!.revisionId).toBe(contextBefore)
        expect(requests).toHaveLength(1)
        await finish(await runtime.submitRunWithAttachments({ threadId, runId: secondRunId, submissionId: randomUUID(), text: 'Second question' }))
        expect(JSON.stringify(requests[1])).toContain('Reply 1')
        const regenerated = await runtime.regenerateMessage({ threadId, messageId: secondRunId + ':input', runId: randomUUID() })
        await finish({ ...regenerated, thread: storage.getThread(threadId)! })
        expect(JSON.stringify(requests[2])).not.toContain('Reply 2')
        await runtime.shutdown(); storage.close()
        storage = AgentStorage.openNative(root); runtime = new NativeRuntimeCoordinator(storage, sink, options)
        expect(runtime.getRunSubmission(submissionId)?.run.id).toBe(firstRunId)
        expect(runtime.recoverRun(threadId)).toBeUndefined()
        expect(requests).toHaveLength(3)
        const compression = await runtime.startCompression(threadId)
        await finish({ ...compression, thread: storage.getThread(threadId)! })
        await finish(await runtime.submitRunWithAttachments({ threadId, runId: randomUUID(), submissionId: randomUUID(), text: 'After compression' }))
        expect(JSON.stringify(requests[4])).toContain('Reply 4')
        expect(await runtime.getContextStatus(threadId)).toMatchObject({ compressionApplied: true })
        mode = 'review'
        const reviewed = await runtime.submitRunWithAttachments({ threadId, runId: randomUUID(), submissionId: randomUUID(), text: codeReviewPrompt(review), codeReview: review })
        await finish(reviewed)
        const savedInput = runtime.databaseForThread(threadId).runs.readRunInput({ threadId, runId: reviewed.run.id })
        expect(savedInput?.value.context?.reviewScope).toEqual(review)
        expect(JSON.stringify((await runtime.getSnapshot(threadId)).messages)).toContain('Reviewed saved scope')
        const regeneratedReview = await runtime.regenerateMessage({ threadId, messageId: reviewed.run.id + ':input', runId: randomUUID() })
        await finish({ ...regeneratedReview, thread: storage.getThread(threadId)! })
        mode = 'delegate'; delegateRunId = randomUUID()
        await finish(await runtime.submitRunWithAttachments({ threadId, runId: delegateRunId, submissionId: randomUUID(), text: 'Delegate and collect' }))
        expect(parentRequests).toBe(3); expect(childRequests).toBe(1)
        const children = runtime.databaseForThread(threadId).resources.listSubagentCallsForParentRun(delegateRunId)
        expect(children).toMatchObject([{ status: 'completed', result: 'Child completed' }])
        expect(runtime.forThread(children[0].childThreadId)).toBe(runtime.forThread(threadId))
        mode = 'plain'
        const simpleId = randomUUID()
        await finish(await runtime.submitRunWithAttachments({ threadId: simpleId, runId: randomUUID(), submissionId: randomUUID(),
          newThread: { projectId: 'simple-project', modelConfigId: 'preview-model' }, text: 'Simple chat' }))
        expect(requests.at(-1)?.tools ?? []).toEqual([])
        const countBeforeInspection = requests.length
        snapshot.providers[0].models[0].maxContextTokens = 120_000
        expect(await runtime.getContextStatus(simpleId)).toMatchObject({ maxContextTokens: 120_000 })
        expect(runtime.loadEarlierActivities({ threadId: simpleId, runId: storage.conversationForThread(simpleId).messages.activities.getLatestRunForThread(simpleId)!.id,
          beforeSequence: Number.MAX_SAFE_INTEGER }).models).toHaveLength(1)
        expect((await runtime.loadEarlierMessages({ threadId: simpleId, beforeIndex: 0 })).messages).toHaveLength(2)
        expect(requests).toHaveLength(countBeforeInspection)
        expect(storage.listThreads()).toHaveLength(2)
      } finally { await runtime.shutdown(); storage.close() }
    })

it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    'assembles native product resources for %s, persists tools and directions, and resumes without another request', async protocol => {
      const snapshot = previewConfig()
      snapshot.providers[0].protocol = protocol
      snapshot.settings.maxModelCallsPerRun = 2
      appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
      const project = defaultWorkspaceProject()
      if (project.kind !== 'workspace') throw new Error('Expected fixture workspace')
      project.sourceFolders = [testPaths.root]
      project.capabilities = { ...structuredClone(defaultCapabilities), environment: false, memory: false,
        skills: { mode: 'off', project: false, entries: [] }, customTools: { mode: 'off', project: false, entries: [] },
        subagents: { ...defaultCapabilities.subagents, mode: 'off' }, toolMode: 'selected', tools: ['sleep', 'read_file'], planning: true, backgroundTools: false }
      projectStoreMocks.getProject.mockResolvedValue(project)
      const file = join(testPaths.root, `native-product-${protocol}.sqlite`)
      const native = new NativeDatabase(file), memoryDatabase = new NativeDatabase(':memory:')
      initializeNativeConversationStorage(native)
      const attachmentRoot = join(testPaths.root, `native-product-${protocol}-attachments`)
      const database = new ConversationResourceReader(native, attachmentRoot, new SqliteMemoryStore(memoryDatabase),
        new FileChangeLedger(native), new FileEditStore(join(testPaths.root, 'native-product-file-edits')))
      const queue = new QueuedInputStore(native, attachmentRoot), results = new NativeManagedResults(native)
      const managedStorage = new ManagedCallStore(native, call => results.validateCallResult(call)), managedCalls = new ManagedCallService(managedStorage, results)
      const projection = new NativeMessageProjection(native), reader = new NativeMessageReader(native)
      const runId = 'native-product-run',
        runOwner = new NativeRunOwner(native, commit => projection.commit(commit)), store = runOwner.store
      const { thread: target } = runOwner.createThreadAndRun({ threadId: 'native-product-thread', runId,
        thread: { modelConfigId: 'preview-model' }, submissionId: 'native-product-submission',
        message: { id: 'input', value: { id: 'input', kind: 'user', content: 'Do work', context: { runId } } } })
      const source = join(testPaths.root, `native-read-${protocol}.txt`)
      await writeFile(source, 'Native managed result reaches the next model request.', 'utf8')
      const attachment = join(testPaths.root, `native-queued-${protocol}.txt`)
      await writeFile(attachment, 'Durable queued attachment reaches the next model request.', 'utf8')
      const archived = await archiveAgentAttachments([{ path: attachment, name: 'queued.txt', mimeType: 'text/plain', size: (await readFile(attachment)).length, kind: 'text', contextPolicy: 'one_turn' }],
        { threadId: target.id, runId: 'queued-follow-up', messageId: 'queued-follow-up' }, attachmentRoot)
      queue.createQueuedInput({ id: 'queued-follow-up', threadId: target.id, text: 'Then report the result' }, archived)
      const request = { threadId: target.id, runId, signal: new AbortController().signal }
      const calls = [{ id: 'plan', name: 'write_todos', args: { todos: [{ content: 'Complete task', status: 'completed' }] } },
        { id: 'pause', name: 'sleep', args: { seconds: 1, summary: 'Wait for fixture' } },
        { id: 'read', name: 'read_file', args: { path: source } }]
      const bodies: Record<string, unknown>[] = []
      const providerFetch = vi.fn<typeof fetch>(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        const first = bodies.length === 1
        if (first) expect(runOwner.queueDirection({ threadId: target.id, runId }, 'queued-follow-up')).toBe(true)
        snapshot.providers[0].models[0].model = 'changed-during-run'
        const content = first ? '' : 'Done with follow-up'
        if (protocol === 'anthropic_messages') return Response.json({ id: 'response', type: 'message', role: 'assistant', model: 'preview-model',
          content: first ? calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args })) : [{ type: 'text', text: content }],
          stop_reason: first ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } })
        if (protocol === 'openai_responses') return Response.json({ id: 'response', object: 'response', status: 'completed', model: 'preview-model',
          output: first ? calls.map(call => ({ type: 'function_call', id: `item-${call.id}`, call_id: call.id, name: call.name, arguments: JSON.stringify(call.args), status: 'completed' }))
            : [{ type: 'message', id: 'final', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: content, annotations: [] }] }],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } })
        return Response.json({ id: 'response', object: 'chat.completion', created: 1, model: 'preview-model',
          choices: [{ index: 0, finish_reason: first ? 'tool_calls' : 'stop', message: { role: 'assistant', content,
            ...(first ? { tool_calls: calls.map(call => ({ type: 'function', id: call.id, function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
      })
      const owner: ConversationInstanceOwner = { store, results, configuration: runOwner,
        managed: { format: 'conversation', get: (id, threadId) => managedStorage.getManagedCall(id, threadId),
          remove: (id, threadId) => managedStorage.deleteManagedCall(id, threadId), read: (reference, threadId) => results.read(reference, threadId) },
        enter: (command, request) => runOwner.enter(command, request),
        directions: state => runOwner.directions(state), persistFileChange: vi.fn() }
      const observed: RunObserver = { started: vi.fn(), startModel: vi.fn(() => 'model'), discardModel: vi.fn(), model: vi.fn(),
        tool: vi.fn(), approval: vi.fn(), committed: vi.fn(async () => {}) }
      const onContextStatus = vi.fn(() => { throw new Error('Context display unavailable') })
      const instance = await createConversationInstance(target, database, snapshot, { requestId: runId, prepareWorkspace: false, providerFetch, onContextStatus, managedCalls }, owner, project)
      try {
        const preview = JSON.parse(await captureAgentModelRequest(target, database, snapshot, managedCalls, project))
        const result = await instance.execution.execute('input', request, observed)
        expect(result.result.status).toBe('fulfilled')
        expect(result.observationErrors).toHaveLength(1)
        expect(bodies).toHaveLength(2)
        expect(bodies[0].tools).toEqual(preview.request.body.tools)
        expect(bodies[1].model).toBe('changed-during-run')
        expect(JSON.stringify(bodies[1])).toContain('Then report the result')
        expect(JSON.stringify(bodies[1])).toContain('Native managed result reaches the next model request.')
        expect(JSON.stringify(bodies[1])).toContain('Durable queued attachment reaches the next model request.')
        expect(queue.getQueuedInput(target.id, 'queued-follow-up')).toBeNull()
        expect(database.listAttachmentsForThread(target.id).filter(item => item.messageId === `${runId}:direction:queued-follow-up`).map(item => item.id)).toEqual(archived.map(item => item.artifact.id))
        const completed = store.load(target.id)!
        expect(completed.phase).toBe('completed')
        expect(native.prepare('SELECT status FROM agent_runs WHERE id=?').get(runId)).toEqual({ status: 'completed' })
        expect(database.getThread(target.id)!.status).toBe('idle')
        expect(native.prepare('SELECT * FROM agent_run_input_intents').all()).toEqual([])
        expect(completed.context.todos).toEqual(calls[0].args.todos)
        expect(completed.messages.map(message => message.value.kind)).toEqual(['user', 'assistant', 'tool', 'tool', 'tool', 'user', 'assistant'])
        expect(completed.messages[3].value.resultFor).toBe('pause')
        expect(reader.window(target.id).messages.map(message => message.role)).toEqual(['user', 'user', 'assistant'])
        expect(reader.window(target.id).messages[1].id).toBe(`${runId}:direction:queued-follow-up`)
        expect(JSON.stringify(reader.window(target.id).messages.at(-1))).toContain('Done with follow-up')
        expect(new Set(reader.runMessages(runId).map(message => message.id))).toEqual(new Set(completed.messages.map(message => message.id)))
        expect(observed.tool).toHaveBeenCalledWith(expect.objectContaining({ kind: 'settled', call: expect.objectContaining({ id: store.readModelCallIds(target.id, completed.messages[1].recordId)[1] }) }))
        expect(onContextStatus).toHaveBeenCalledTimes(3)
        expect(native.prepare("SELECT name FROM sqlite_schema WHERE name IN ('current_state','message_bodies','pending_writes')").all()).toEqual([])
        validateNativeExecutionStorage(native)
        await instance.dispose()
        const restoredOwner = new NativeRunOwner(native, commit => projection.commit(commit))
        const restored = await createConversationInstance(target, database, snapshot, { requestId: runId, prepareWorkspace: false, providerFetch },
          { ...owner, store: restoredOwner.store, enter: (command, request) => restoredOwner.enter(command, request) }, project)
        expect((await restored.execution.execute('continue', request, observed)).result.status).toBe('fulfilled')
        expect(providerFetch).toHaveBeenCalledTimes(2)
        await restored.dispose()
      } finally { await instance.dispose(); await managedCalls.shutdown(); native.close(); memoryDatabase.close() }
    })

it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    'uses only native storage for configured %s conversations, managed tools, attachments, reopen and regeneration', async protocol => {
      const snapshot = previewConfig(); snapshot.providers[0].protocol = protocol
      appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
      const project = defaultWorkspaceProject()
      if (project.kind !== 'workspace') throw new Error('Expected fixture workspace')
      project.sourceFolders = [testPaths.root]
      project.capabilities = { ...structuredClone(defaultCapabilities), environment: false, memory: false,
        skills: { mode: 'off', project: false, entries: [] }, customTools: { mode: 'off', project: false, entries: [] },
        subagents: { ...defaultCapabilities.subagents, mode: 'off' }, toolMode: 'selected', tools: ['read_file'], planning: false, backgroundTools: false }
      projectStoreMocks.getProject.mockResolvedValue(project)
      const file = join(testPaths.root, `native-only-${protocol}.sqlite`), attachments = join(testPaths.root, `native-only-${protocol}-attachments`)
      const memoryDatabase = new NativeDatabase(':memory:'), memory = new SqliteMemoryStore(memoryDatabase)
      const source = join(testPaths.root, `native-only-${protocol}.txt`)
      const bodies: Record<string, unknown>[] = []
      const providerFetch = vi.fn<typeof fetch>(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        if (bodies.length === 1) {
          if (protocol === 'anthropic_messages') return Response.json({ id: 'tool-response', type: 'message', role: 'assistant', model: 'preview-model',
            content: [{ type: 'tool_use', id: 'read-call', name: 'read_file', input: { path: source } }], stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 } })
          if (protocol === 'openai_responses') return Response.json({ id: 'tool-response', object: 'response', status: 'completed', model: 'preview-model',
            output: [{ type: 'function_call', id: 'read-item', call_id: 'read-call', name: 'read_file', arguments: JSON.stringify({ path: source }), status: 'completed' }],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } })
          return Response.json({ id: 'tool-response', object: 'chat.completion', created: 1, model: 'preview-model',
            choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '',
              tool_calls: [{ type: 'function', id: 'read-call', function: { name: 'read_file', arguments: JSON.stringify({ path: source }) } }] } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
        }
        const content = `Answer ${bodies.length}`
        if (protocol === 'anthropic_messages') return Response.json({ id: 'response', type: 'message', role: 'assistant', model: 'preview-model',
          content: [{ type: 'text', text: content }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } })
        if (protocol === 'openai_responses') return Response.json({ id: 'response', object: 'response', status: 'completed', model: 'preview-model',
          output: [{ type: 'message', id: 'final', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: content, annotations: [] }] }],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } })
        return Response.json({ id: 'response', object: 'chat.completion', created: 1, model: 'preview-model',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
      })
      const services = () => {
        const database = NativeConversationDatabase.open(file, { attachmentRoot: attachments, memoryStore: memory,
          fileEditStore: new FileEditStore(join(testPaths.root, 'native-file-edits')) })
        const service = new ManagedCallService(database.managed, database.results)
        return { database, owner: database.runs, resources: database.resources, history: database.history, reader: database.messages,
          calls: database.managed, service, host: new NativeRunHost(database, service, { push: event => events.push(event) }) }
      }
      const events: AgentRuntimeEvent[] = []
      const contextFor = (runId: string) => current.database.activityProjection.contextCallbacks(runId, 'thread', { push: event => events.push(event) })
      let current = services()
      let managedCreated = vi.spyOn(current.calls, 'createManagedCall')
      try {
        current.owner.createThread({ modelConfigId: 'preview-model' }, 'thread')
        await writeFile(source, 'Archived native attachment')
        const archived = await archiveAgentAttachments([{ path: source, name: 'attachment.txt', mimeType: 'text/plain', size: 26,
          kind: 'text', contextPolicy: 'conversation' }], { threadId: 'thread', runId: 'first', messageId: 'first:input' }, attachments)
        for (const runId of ['first', 'second', 'regenerated']) {
          const create = (context: NativeRunContext) => createConversationInstance(current.resources.getThread('thread')!, current.resources, snapshot,
            { ...context, prepareWorkspace: false, providerFetch, managedCalls: current.service }, current.database.execution, project)
          const handle = await (async () => {
            if (runId === 'regenerated') return (await current.host.regenerateMessage({ threadId: 'thread', messageId: 'second:input', runId }, create)).handle
            if (runId === 'second') return (await current.host.submitRunWithAttachments({ threadId: 'thread', runId,
              submissionId: randomUUID(), text: 'second question' }, create)).handle!
            current.owner.createRun({ threadId: 'thread', runId, operation: 'agent', attachments: runId === 'first' ? archived : [],
              message: { id: `${runId}:input`, value: { id: `${runId}:input`, kind: 'user', content: `${runId} question`, context: { runId } } } })
            let instance = await createConversationInstance(current.resources.getThread('thread')!, current.resources, snapshot,
              { requestId: runId, prepareWorkspace: false, providerFetch, managedCalls: current.service, ...contextFor(runId) }, current.database.execution, project)
            if (runId === 'first') {
              const saved = current.owner.getRunConfiguration({ threadId: 'thread', runId })
              expect(saved?.capabilities.tools).toEqual(['read_file'])
              await instance.dispose(); await current.service.shutdown(); current.database.close(); current = services()
              managedCreated = vi.spyOn(current.calls, 'createManagedCall')
              const previous = project.capabilities
              project.capabilities = { ...previous!, tools: [] }
              try {
                instance = await createConversationInstance(current.resources.getThread('thread')!, current.resources, snapshot,
                  { requestId: runId, prepareWorkspace: false, providerFetch, managedCalls: current.service, ...contextFor(runId) }, current.database.execution, project)
                expect(current.owner.getRunConfiguration({ threadId: 'thread', runId })).toEqual(saved)
              } finally { project.capabilities = previous }
            }
            await instance.dispose()
            return current.host.start({ threadId: 'thread', runId }, 'input', create)
          })()
          expect((await handle.completed).status).toBe('completed')
          await handle.drained
          expect(handle.diagnostics).toEqual([])
          const count = bodies.length
          const continued = current.host.start({ threadId: 'thread', runId }, 'continue', async () => { throw new Error('Completed runs do not need another instance') })
          expect((await continued.completed).status).toBe('completed')
          await continued.drained
          expect(continued.diagnostics).toEqual([])
          expect(bodies).toHaveLength(count)
          current.database.validate()
          await current.service.shutdown()
          current.database.close(); current = services()
        }
        expect(events.find(event => event.type === 'run_started' && event.run.id === 'regenerated')).toMatchObject({ newUserTurn: false })
        expect(bodies).toHaveLength(4)
        expect(JSON.stringify(bodies[0])).toContain('Archived native attachment')
        expect(JSON.stringify(bodies[1])).toContain('read-call')
        expect(JSON.stringify(bodies[1])).toContain('Archived native attachment')
        expect(JSON.stringify(bodies[2])).toContain('Answer 2')
        expect(JSON.stringify(bodies[2])).toContain('second question')
        expect(JSON.stringify(bodies[3])).not.toContain('Answer 3')
        expect(current.reader.window('thread').messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
        expect(JSON.stringify(current.reader.window('thread'))).toContain('Answer 4')
        expect(managedCreated).toHaveBeenCalledOnce()
        const toolResult = current.owner.store.readHistory('thread')!.messages.find(message => message.value.kind === 'tool')!.value
        expect(toolResult).toMatchObject({ resultFor: 'read-call' })
        expect(String(toolResult.content)).toContain('Archived native attachment')
        for (const runId of ['compress', 'after-compression']) {
          const manualCompression = runId === 'compress'
          const create = (context: NativeRunContext) => createConversationInstance(current.resources.getThread('thread')!, current.resources, snapshot,
            { ...context, prepareWorkspace: false, providerFetch, managedCalls: current.service, manualCompression }, current.database.execution, project)
          const handle = manualCompression ? (await current.host.startCompression('thread', create, runId)).handle
            : (await current.host.submitRunWithAttachments({ threadId: 'thread', runId, submissionId: randomUUID(), text: 'Continue after summary' }, create)).handle!
          expect((await handle.completed).status).toBe('completed')
          await handle.drained
          expect(handle.diagnostics).toEqual([])
          current.database.validate()
          if (manualCompression) {
            const start = events.findIndex(event => event.type === 'context_compression_started' && event.runId === runId)
            expect(start).toBeGreaterThan(0)
            const status = events.slice(0, start).filter(event => event.type === 'context_status_updated').at(-1)?.status
            expect(status).toMatchObject({ runId, maxContextTokens: 100_000, maxOutputTokens: 4_000 })
            expect(status!.breakdown.messageTokens).toBeGreaterThan(0)
          }
          await current.service.shutdown(); current.database.close(); current = services()
        }
        expect(bodies).toHaveLength(6)
        expect(JSON.stringify(bodies[4])).toContain('Answer 4')
        expect(JSON.stringify(bodies[5])).toContain('Answer 5')
        expect(JSON.stringify(bodies[5])).not.toContain('Answer 2')
        expect(current.reader.window('thread').messages).toHaveLength(6)
        const longRun = { threadId: 'thread', runId: 'long-history' }
        current.owner.createRun({ ...longRun, operation: 'agent', message: { id: 'long-history:input', value: {
          id: 'long-history:input', kind: 'user', content: 'Earlier details. '.repeat(8000), context: { runId: longRun.runId } } } })
        await current.owner.enter('input', longRun)
        const longScope = () => ({ ...longRun, expectedRevisionId: current.owner.store.load('thread')!.revisionId })
        current.owner.store.acceptModel(longScope(), { id: 'long-answer', value: { kind: 'assistant', content: 'Long task finished' } }, [], { modelCalls: 1, todos: [] })
        current.owner.store.finish(longScope(), 'completed')
        Object.assign(snapshot.providers[0].models[0], { contextCompressionEnabled: true, contextCompressionThreshold: 0.1 })
        current.owner.createRun({ threadId: 'thread', runId: 'auto-compression', operation: 'agent', message: { id: 'auto-compression:input', value: {
          id: 'auto-compression:input', kind: 'user', content: 'Next task after long history', context: { runId: 'auto-compression' } } } })
        const automatic = current.host.start({ threadId: 'thread', runId: 'auto-compression' }, 'input', context =>
          createConversationInstance(current.resources.getThread('thread')!, current.resources, snapshot,
            { ...context, prepareWorkspace: false, providerFetch, managedCalls: current.service }, current.database.execution, project))
        expect((await automatic.completed).status).toBe('completed')
        await automatic.drained
        expect(automatic.diagnostics).toEqual([])
        current.database.validate()
        const readModel = current.owner.store.readHistory('thread')!.messages.find(record => record.value.calls?.some(call => call.id === 'read-call'))!
        const readCallId = current.owner.store.readModelCallIds('thread', readModel.recordId)[0]
        expect(events.filter(event => event.type === 'tool_completed' && event.call.id === readCallId)).toHaveLength(1)
        expect(events).toContainEqual(expect.objectContaining({ type: 'model_completed', runId: 'auto-compression', model: expect.objectContaining({ text: 'Answer 8' }) }))
        expect(bodies).toHaveLength(8)
        expect(JSON.stringify(bodies[6])).toContain('Earlier details.')
        expect(JSON.stringify(bodies[7])).toContain('Answer 7')
        expect(JSON.stringify(bodies[7])).not.toContain('Earlier details.')
        expect(current.database.readSnapshot('thread').activities.find(activity => activity.runId === 'auto-compression')?.summaries)
          .toMatchObject([{ status: 'completed', summaryText: 'Answer 7' }])
        expect(events.filter(event => event.type === 'context_compression_completed')).toMatchObject([
          { runId: 'compress', summary: { status: 'completed', summaryText: 'Answer 5' } },
          { runId: 'auto-compression', summary: { status: 'completed', summaryText: 'Answer 7' } }
        ])
        const contextEvents = events.filter(event => event.type === 'context_status_updated')
        expect(contextEvents.length).toBeGreaterThan(0)
        expect(current.database.readSnapshot('thread').contextStatus).toEqual(contextEvents.at(-1)!.status)
        // Foreground task ownership is released after its result is accepted.
        // Read-only results remain in history without a write-effect journal.
        expect(current.calls.listUnresolvedManagedCalls('first')).toEqual([])
        const inspection = new NativeDatabase(file, { readonly: true })
        try {
          expect(inspection.prepare('SELECT status,summary_text,committed_checkpoint_id FROM agent_context_summaries WHERE run_id=?').get('compress'))
            .toEqual({ status: 'completed', summary_text: 'Answer 5', committed_checkpoint_id: expect.any(String) })
          expect(inspection.prepare('SELECT status,summary_text FROM agent_context_summaries WHERE run_id=?').all('auto-compression'))
            .toEqual([{ status: 'completed', summary_text: 'Answer 7' }])
          expect(inspection.prepare('SELECT status FROM agent_managed_calls').all()).toEqual([])
          expect(inspection.prepare('SELECT state FROM execution_effects WHERE tool_name=?').all('read_file')).toEqual([])
          expect(inspection.prepare("SELECT name FROM sqlite_schema WHERE name IN ('current_state','message_bodies','pending_writes','agent_effect_journal')").all()).toEqual([])
        } finally { inspection.close() }
        const parent = { threadId: 'thread', runId: 'delegation' }
        current.owner.createRun({ ...parent, operation: 'agent', message: { id: 'delegation:input', value: {
          id: 'delegation:input', kind: 'user', content: 'Delegate independent work', context: { runId: 'delegation' } } } })
        current.owner.resolveRunConfiguration(parent, { codingMode: false, customTools: [], capabilities: project.capabilities })
        await current.owner.enter('input', parent)
        snapshot.providers[0].models[0].contextCompressionEnabled = false
        snapshot.providers[0].models.push({ ...snapshot.providers[0].models[0], id: 'child-model', model: 'child-specific-model' })
        const children: NativeSubagentService = new NativeSubagentService(current.database, current.host, {
          configuration: async () => snapshot,
          snapshot: threadId => current.database.readSnapshotWithPreviews(threadId, testPaths.root),
          create: (call, context) => createConversationInstance(current.resources.getThread(call.childThreadId)!, current.resources, snapshot,
            { ...context, prepareWorkspace: false, providerFetch, managedCalls: current.service, subagentCall: call,
              subagents: children.forRun({ threadId: call.childThreadId, runId: call.childRunId }) }, current.database.execution, project)
        })
        const childRuntime = children.forRun(parent)
        for (const explicit of [false, true]) {
          const identity = { subagentId: randomUUID(), childThreadId: randomUUID(), childRunId: randomUUID() }
          await childRuntime.start({ agentName: 'helper', config: { name: 'helper', index: 0, enabled: true, builtIn: false,
            description: 'Delegate work', systemPrompt: 'Complete only the delegated task.', capabilities: structuredClone(project.capabilities),
            ...(explicit ? { modelConfigId: 'child-model' } : {}) } }, 'Independent child request', identity, () => {})
          await current.host.waitForIdle()
          const result = await childRuntime.read(identity.subagentId)
          expect(Array.isArray(result)).toBe(false)
          if (Array.isArray(result)) throw new Error('Expected one child')
          expect(result.call).toMatchObject({ status: 'completed', result: explicit ? 'Answer 10' : 'Answer 9' })
          expect(current.owner.getRunConfiguration({ threadId: identity.childThreadId, runId: identity.childRunId })?.capabilities.tools).toEqual(['read_file'])
          childRuntime.resolveObserved(identity.subagentId)
        }
        expect(bodies[8].model).toBe(snapshot.providers[0].models[0].model)
        expect(bodies[9].model).toBe('child-specific-model')
        expect(JSON.stringify(bodies[8])).toContain('Independent child request')
        expect(JSON.stringify(bodies[8])).not.toContain('Earlier details.')
        expect(current.reader.window('thread').messages.some(message => JSON.stringify(message).includes('Answer 9'))).toBe(false)
        expect(childRuntime.unresolvedForRun()).toEqual([])
        current.host.cancel(parent); await current.host.waitForIdle(); current.database.validate()

        project.capabilities.subagents = { mode: 'default', names: [] }
        snapshot.subagents = [{ name: 'helper', index: 0, enabled: true, builtIn: false, description: 'Delegate independent work',
          systemPrompt: 'CHILD_EXECUTOR_MARKER: complete only your assigned task.',
          capabilities: { ...structuredClone(project.capabilities), subagents: { mode: 'off', names: [] } } }]
        const toolParent = { threadId: 'thread', runId: 'delegated-tools' }
        current.owner.createRun({ ...toolParent, operation: 'agent', message: { id: 'delegated-tools:input', value: {
          id: 'delegated-tools:input', kind: 'user', content: 'Delegate work and collect its answer.', context: { runId: toolParent.runId } } } })
        let parentRequests = 0, childRequests = 0
        providerFetch.mockImplementation(async (_url, init) => {
          const request = String(init?.body), child = request.includes('CHILD_EXECUTOR_MARKER')
          if (child) childRequests++
          else parentRequests++
          let call: { id: string; name: string; args: Record<string, unknown> } | undefined
          if (!child && parentRequests === 1) call = { id: 'start-child-call', name: 'start_subagent', args: { agent: 'helper', description: 'Child-only task' } }
          if (!child && parentRequests === 2) {
            const [created] = current.resources.listSubagentCallsForParentRun(toolParent.runId)
            expect(created).toBeDefined()
            call = { id: 'wait-child-call', name: 'wait_subagent', args: { subagent_id: created.id } }
          }
          const content = child ? 'Child job complete' : 'Parent used the child result'
          if (protocol === 'anthropic_messages') return Response.json({ id: 'delegated-response', type: 'message', role: 'assistant', model: 'preview-model',
            content: call ? [{ type: 'tool_use', id: call.id, name: call.name, input: call.args }] : [{ type: 'text', text: content }],
            stop_reason: call ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } })
          if (protocol === 'openai_responses') return Response.json({ id: 'delegated-response', object: 'response', status: 'completed', model: 'preview-model',
            output: call ? [{ type: 'function_call', id: `${call.id}-item`, call_id: call.id, name: call.name, arguments: JSON.stringify(call.args), status: 'completed' }]
              : [{ type: 'message', id: 'delegated-answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: content, annotations: [] }] }],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } })
          return Response.json({ id: 'delegated-response', object: 'chat.completion', created: 1, model: 'preview-model', choices: [{ index: 0,
            finish_reason: call ? 'tool_calls' : 'stop', message: { role: 'assistant', content: call ? '' : content,
              ...(call ? { tool_calls: [{ type: 'function', id: call.id, function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : {}) } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
        })
        const delegated = current.host.start(toolParent, 'input', context => createConversationInstance(current.resources.getThread('thread')!, current.resources, snapshot,
          { ...context, prepareWorkspace: false, providerFetch, managedCalls: current.service, subagents: children.forRun(toolParent) }, current.database.execution, project))
        expect((await delegated.completed).status).toBe('completed')
        await delegated.drained
        expect(delegated.diagnostics).toEqual([])
        expect({ parentRequests, childRequests }).toEqual({ parentRequests: 3, childRequests: 1 })
        expect(current.resources.listSubagentCallsForParentRun(toolParent.runId)).toMatchObject([{ status: 'completed', result: 'Child job complete' }])
        expect(current.resources.listUnresolvedSubagentCallsForRun(toolParent.runId)).toEqual([])
        expect(current.reader.window('thread').messages.at(-1)?.content).toMatchObject([{ type: 'text', text: 'Parent used the child result' }])
        expect(current.reader.window('thread').messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes('Child job complete'))).toBe(false)
        current.database.validate()
      } finally { await current.service.shutdown(); current.database.close(); memoryDatabase.close() }
    })
})

it('executes selected custom scripts through native state, corrects errors and preserves the definition across reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anas-custom-native-'))
  const scriptPath = join(root, 'submit.cjs')
  await writeFile(scriptPath, `const data=JSON.parse(process.argv[2]);if(!data.title.trim()){console.log(JSON.stringify({ok:false,error:'title is blank'}))}else{require('fs').appendFileSync('received.jsonl',JSON.stringify(data)+'\\n');console.log(JSON.stringify({ok:true,accepted:data.title}))}`)
  const snapshot = previewConfig()
  snapshot.customTools = [toolPackageFixture({ ...customToolDefaults, id: 'submit', name: 'submit_result', description: 'Submit a title.', directory: root,
    command: `"${process.execPath}" "${scriptPath}" {{args}}`, inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } })]
  snapshot.subagents = []
  vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
  appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
  projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), sourceFolders: [root],
    capabilities: { ...structuredClone(defaultCapabilities), customTools: selectedTools(['submit']), memory: false,
      subagents: { mode: 'off' as const, names: [] }, skills: { mode: 'off', project: false, entries: [] } } })
  memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('')
  const global = new NativeDatabase(':memory:')
  const open = () => NativeConversationDatabase.open(join(root, 'agent.sqlite'), { attachmentRoot: join(root, 'attachments'),
    memoryStore: new SqliteMemoryStore(global), fileEditStore: new FileEditStore(join(root, 'file-edits')) })
  let database = open(), managedCalls = new ManagedCallService(database.managed, database.results)
  const thread = database.createThread({ modelConfigId: 'preview-model', title: 'Custom tools' })
  const run = database.runs.createRun({ threadId: thread.id, runId: 'custom-native', operation: 'agent', message: {
    id: 'custom-input', value: { id: 'custom-input', kind: 'user', content: 'Submit a result.', context: { runId: 'custom-native' } }
  } })
  const calls = [
    { id: 'invalid', name: 'submit_result', args: { title: 123 } },
    { id: 'business-error', name: 'submit_result', args: { title: ' ' } },
    { id: 'corrected', name: 'submit_result', args: { title: '有效标题' } }
  ]
  const requests: { tools: { function: { name: string } }[] }[] = []
  const providerFetch = vi.fn<typeof fetch>(async (_url, init) => {
    const call = calls[requests.length]
    requests.push(JSON.parse(String(init?.body)))
    return Response.json({ id: `response-${requests.length}`, object: 'chat.completion', created: 1, model: 'preview-model',
      choices: [{ index: 0, finish_reason: call ? 'tool_calls' : 'stop', message: { role: 'assistant', content: call ? '' : 'Submitted',
        ...(call ? { tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : {}) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  })
  const observer: RunObserver = { started: vi.fn(), startModel: vi.fn(() => 'observation'), discardModel: vi.fn(),
    model: vi.fn(), tool: vi.fn(), approval: vi.fn(), committed: vi.fn(async () => {}) }
  try {
    const initial = await createConversationInstance(thread, database.resources, snapshot,
      { requestId: run.id, prepareWorkspace: false, managedCalls, providerFetch }, database.execution)
    await initial.dispose()
    const originalCommand = snapshot.customTools[0].definition!.command
    snapshot.customTools[0].definition!.name = 'renamed_after_run'
    snapshot.customTools[0].definition!.command = 'another-command {{args}}'
    await managedCalls.shutdown(); database.close()
    database = open(); managedCalls = new ManagedCallService(database.managed, database.results)
    const configuration = database.runs.getRunConfiguration({ threadId: thread.id, runId: run.id })!
    expect(configuration.customTools[0]).toMatchObject({ name: 'submit_result', command: originalCommand })
    const resumed = await createConversationInstance(thread, database.resources, snapshot,
      { requestId: run.id, prepareWorkspace: false, managedCalls, providerFetch }, database.execution)
    try {
      const result = await resumed.execution.execute('input', { threadId: thread.id, runId: run.id, signal: new AbortController().signal }, observer)
      expect(result.result.status).toBe('fulfilled')
      expect(result.observationErrors).toEqual([])
      const state = database.runs.store.load(thread.id)!
      expect(state.phase).toBe('completed')
      expect(state.messages.map(record => record.value).filter(message => message.kind === 'tool')).toMatchObject([
        { resultFor: 'invalid', resultStatus: 'error' },
        { resultFor: 'business-error', resultStatus: 'success', content: expect.stringContaining('title is blank') },
        { resultFor: 'corrected', resultStatus: 'success', content: expect.stringContaining('有效标题') }
      ])
      expect(observer.approval).not.toHaveBeenCalled()
      expect(await readFile(join(root, 'received.jsonl'), 'utf8')).toBe('{"title":"有效标题"}\n')
      expect(requests).toHaveLength(4)
      for (const request of requests) {
        const names = request.tools.map(tool => tool.function.name)
        expect(names).toContain('submit_result')
        expect(names).not.toContain('renamed_after_run')
      }
    } finally { await resumed.dispose() }
  } finally { await managedCalls.shutdown(); database.close(); global.close(); await rm(root, { recursive: true, force: true }) }
})
