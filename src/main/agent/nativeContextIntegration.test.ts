import { z } from 'zod'
import { defineContentTool } from '../../runtime/toolDefinition'
import type { SkillScriptInvocation } from '../skillsStore'
import * as shellCommandAuthorization from '../shellCommandAuthorization'
import * as shellRuntime from '../shellRuntime'
import * as bundledRipgrep from '../bundledRipgrep'
import { verifyCurrentShellAuthorization } from './toolAuthorizationRuntime'
import { captureCodeReview, codeReviewPrompt } from './codeReview'
import { codeReviewToolDeclaration } from '../../runtime/codeReviewReport'
import { createPatch } from 'diff'
import * as gitChanges from '../gitChanges'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { contentText } from '../../runtime/inputContent'
import { conversationContentBlocks } from '../../providers/conversationInput'
import { simpleConversationHistory } from './conversationHistoryProjection'
import { presentConversationMessage } from './conversationPresentation'
import { conversationContextSource } from './conversationModelExecution'
import { countConversationTokens, conversationRequestKey } from './conversationContext'
import { projectConversationContextStatus } from './conversationPreview'
import { createConversationInstance } from './conversationInstance'
import * as conversationModel from './conversationModel'
import * as compressionModel from './compressionModel'
import * as mcpRuntimeService from '../mcpRuntimeService'
import * as runtimeTools from '../llm/runtimeTools'
import { ManagedCallService } from './managedCallService'
import { NativeAgentRuntime } from './nativeAgentRuntime'
import { initializeNativeConversationStorage } from './nativeDatabaseSchema'
import { NativeExecutionStore } from './nativeExecutionStore'
import { createThreadRecord } from './conversationThreads'
import { conversationMessageRecordId, encodeConversationMessage } from '../../runtime/conversationStorage'
import { randomUUID } from 'node:crypto'
import { createCompressionTracking } from './contextSummaryStore'
import type { RunObserver } from '../../runtime/runExecution'

import * as toolsStore from '../toolsStore'

import Database from 'better-sqlite3'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultCapabilities } from '@shared/agentCapabilities'
import type { ModelProtocol, Project } from '@shared/types'
import { defaultWorkspaceProject, previewConfig } from '../../test/agentConfigurationFixture'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { SqliteMemoryStore } from './memoryStore'
import { FileEditStore } from '../fileEditStore'

const testPaths = vi.hoisted(() => ({ root: '' }))
const projectStoreMocks = vi.hoisted(() => ({ getProject: vi.fn() }))
const appConfigMocks = vi.hoisted(() => ({ getAppConfigSnapshot: vi.fn() }))
const memoryStoreMocks = vi.hoisted(() => ({ buildMemoryRulesPrompt: vi.fn() }))
const languageStoreMocks = vi.hoisted(() => ({ resolveConfiguredLanguage: vi.fn(async () => ({ code: 'en', name: 'English', builtIn: true })) }))
vi.mock('../config/dataDir', async importOriginal => ({ ...await importOriginal<typeof import('../config/dataDir')>(),
  getDataDir: () => testPaths.root, getConfigFile: (name: string) => join(testPaths.root, 'config', name),
  getSkillsDir: () => join(testPaths.root, 'skills'), getSystemSkillsDir: () => join(testPaths.root, 'skills/_system'),
  getSystemPluginsDir: () => join(testPaths.root, 'plugins/_system'), getSkillExamplesDir: () => join(testPaths.root, 'examples/skills') }))
vi.mock('../projectStore', () => ({ getProject: projectStoreMocks.getProject }))
vi.mock('../config/appConfig', async importOriginal => ({ ...await importOriginal<typeof import('../config/appConfig')>(), getAppConfigSnapshot: appConfigMocks.getAppConfigSnapshot }))
vi.mock('./conversationMemory', async importOriginal => ({ ...await importOriginal<typeof import('./conversationMemory')>(), buildMemoryRulesPrompt: memoryStoreMocks.buildMemoryRulesPrompt }))
vi.mock('../languageStore', () => ({ resolveConfiguredLanguage: languageStoreMocks.resolveConfiguredLanguage }))
vi.mock('../toolsStore', async importOriginal => ({ ...await importOriginal<typeof import('../toolsStore')>(), listToolSnapshot: vi.fn(async () => ({ roots: [], tools: [] })) }))
beforeAll(async () => { testPaths.root = await mkdtemp(join(tmpdir(), 'anas-native-context-integration-')) })
afterAll(async () => { await rm(testPaths.root, { recursive: true, force: true }) })
const memories: Database.Database[] = []
const connections: NativeConversationDatabase[] = []
afterEach(() => { vi.restoreAllMocks(); for (const db of connections.splice(0)) db.close(); for (const db of memories.splice(0)) db.close() })
function openDatabase(file = ':memory:') {
  const global = new Database(':memory:'); memories.push(global)
  const database = NativeConversationDatabase.open(file, { memoryStore: new SqliteMemoryStore(global),
    attachmentRoot: join(testPaths.root, 'attachments'), fileEditStore: new FileEditStore(join(testPaths.root, 'file_edits')) })
  connections.push(database)
  return database
}
function configuredThread(database: NativeConversationDatabase, input: Parameters<NativeConversationDatabase['runs']['createThread']>[0] = {}) {
  return database.runs.createThread({ modelConfigId: 'preview-model', ...input })
}
/** An idle history is a valid native state after editing or conversion. Build
 * that state directly, then reopen through the normal product database. */
function openHistoryDatabase(messages: ConversationMessage[], summary?: { cutoffIndex: number; content: string }) {
  const file = join(testPaths.root, randomUUID() + '.sqlite'), raw = new Database(file)
  const record = (message: ConversationMessage) => {
    const value = { ...message, id: message.id ?? randomUUID() }, id = value.id
    return { id, value, recordId: conversationMessageRecordId(id, encodeConversationMessage(value)) }
  }
  let thread
  try {
    initializeNativeConversationStorage(raw)
    thread = createThreadRecord(raw, { modelConfigId: 'preview-model' })
    const summarized = summary ? record({ id: 'summary', kind: 'user', content: summary.content,
      context: { summary: true, summaryId: 'history-summary' } }) : undefined
    const records = messages.map(record)
    new NativeExecutionStore(raw).installHistory({ threadId: thread.id, revisionId: randomUUID(), messages: records,
      ...(summarized ? { summary: { record: summarized, reference: { id: 'history-summary', messageRecordId: summarized.recordId, cutoffIndex: summary!.cutoffIndex } } } : {}) })
    // Idle histories have no run owner. Include the derived indexes required by
    // the current database format; normal opening validates the whole fixture.
    for (const [position, message] of records.entries()) {
      raw.prepare('INSERT INTO agent_message_index(thread_id,position,record_id,message_id,run_id,visible) VALUES (?,?,?,?,NULL,?)')
        .run(thread.id, position, message.recordId, message.id, Number(message.value.kind === 'user' || message.value.kind === 'assistant' && !message.value.calls?.length))
      for (const [index] of (message.value.calls ?? []).entries()) {
        raw.prepare('INSERT INTO execution_model_calls(thread_id,record_id,call_index,call_id) VALUES (?,?,?,?)').run(thread.id, message.recordId, index, randomUUID())
      }
    }
  } finally { raw.close() }
  return { database: openDatabase(file), thread }
}
function observer(): RunObserver {
  return { started: vi.fn(), startModel: vi.fn(() => 'observation'), discardModel: vi.fn(),
    model: vi.fn(), tool: vi.fn(), approval: vi.fn(), committed: vi.fn(async () => {}) }
}
function createRun(database: NativeConversationDatabase, threadId: string, runId: string, content: string) {
  return database.runs.createRun({ threadId, runId, operation: 'agent', message: {
    id: runId + ':input', value: { id: runId + ':input', kind: 'user', content, context: { runId } }
  } })
}
function minimalProject() {
  return { ...defaultWorkspaceProject(), capabilities: {
    ...structuredClone(defaultCapabilities), profile: false, environment: false, workspace: false,
    planning: false, toolMode: 'selected' as const, tools: [], subagents: { mode: 'off' as const, names: [] },
    backgroundTools: false, memory: false, skills: { mode: 'off' as const, project: false, entries: [] }
  } }
}
const completedResponse = (content = 'Done') => Response.json({ id: 'response', object: 'chat.completion', created: 1,
  model: 'preview-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] })
function usageResponse(protocol: ModelProtocol, input: number, output: number) {
  return Response.json(protocol === 'anthropic_messages'
    ? { id: 'msg-usage', type: 'message', role: 'assistant', model: 'preview-model', content: [{ type: 'text', text: 'Done' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: input, output_tokens: output } }
    : protocol === 'openai_responses'
      ? { id: 'response-usage', object: 'response', created_at: 1, status: 'completed', model: 'preview-model',
          output: [{ type: 'message', id: 'msg-usage', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done', annotations: [] }] }],
          usage: { input_tokens: input, output_tokens: output, total_tokens: input + output } }
      : { id: 'chat-usage', object: 'chat.completion', created: 1, model: 'preview-model',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Done' } }],
          usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } })
}
function observeModelRequests() {
  const requests: conversationModel.ConversationModelRequest[] = [], original = conversationModel.createConversationModel
  const factory = vi.spyOn(conversationModel, 'createConversationModel').mockImplementation((config, options) => {
    const model = original(config, options)
    return { invoke: request => { requests.push(request); return model.invoke(request) } }
  })
  return { requests, factory }
}

describe('native context integration', () => {
  beforeEach(() => {
    projectStoreMocks.getProject.mockReset().mockResolvedValue(defaultWorkspaceProject())
    memoryStoreMocks.buildMemoryRulesPrompt.mockReset().mockResolvedValue('')
    appConfigMocks.getAppConfigSnapshot.mockReset().mockResolvedValue(previewConfig())
    vi.mocked(toolsStore.listToolSnapshot).mockReset().mockResolvedValue({ roots: [], tools: [] })
  })
  it.each([true, false])('binds only the latest host-recorded Skill to Shell checks (explicit=%s)', async explicit => {
    const snapshot = previewConfig(), base = minimalProject()
    const project = { ...base, capabilities: { ...base.capabilities, tools: ['run_shell'] } }
    projectStoreMocks.getProject.mockResolvedValue(project)
    const { database, thread } = openHistoryDatabase([{ id: 'old-user', kind: 'user', content: '/old@user report\n\n<skill>Old instructions</skill>', context: { displayText: '/old@user report' } },
      { id: 'old-answer', kind: 'assistant', content: 'Previous task complete' }])
    database.setAccessMode(thread.id, 'strict_approval')
    const inspect = vi.fn(async (_args: Readonly<Record<string, unknown>>, _invocation?: SkillScriptInvocation) => ({ workingDir: testPaths.root, executable: '/shell', paths: [] }))
    vi.spyOn(shellCommandAuthorization, 'createShellCommandAuthorization').mockReturnValue({ inspect, requiresApproval: vi.fn() })
    vi.spyOn(shellRuntime, 'getCommandShell').mockResolvedValue({ executable: 'pwsh.exe', name: 'PowerShell', family: 'powershell' })
    vi.spyOn(bundledRipgrep, 'bundledSearchEnvironment').mockResolvedValue({ executable: 'rg.exe', directory: testPaths.root, env: {} })
    const execute = vi.fn(async () => { await verifyCurrentShellAuthorization(); return 'Shell completed' })
    vi.spyOn(runtimeTools, 'runtimeToolDefinitions').mockResolvedValue([defineContentTool({ name: 'pwsh', description: 'Shell fixture', inputSchema: z.object({ command: z.string() }), execute })])
    const runId = randomUUID(), content = explicit ? '/query@user report\n\n<skill>instructions</skill>' : 'A new ordinary request'
    database.runs.createRun({ threadId: thread.id, runId, operation: 'agent', message: { id: `${runId}:input`, value: { id: `${runId}:input`, kind: 'user', content,
      context: { runId, ...(explicit ? { displayText: '/query@user report' } : {}) } } } })
    let count = 0
    const instance = await createConversationInstance(thread, database.resources, snapshot, { requestId: runId, prepareWorkspace: false,
      providerFetch: async () => ++count === 1 ? Response.json({ id: 'shell-call', object: 'chat.completion', created: 1, model: 'preview-model', choices: [{ index: 0, finish_reason: 'tool_calls',
        message: { role: 'assistant', content: '', tool_calls: [{ id: 'shell-call', type: 'function', function: { name: 'pwsh', arguments: '{"command":"python scripts/query.py"}' } }] } }] }) : completedResponse()
    }, database.execution)
    try {
      const output = await instance.execution.execute('input', { threadId: thread.id, runId, signal: new AbortController().signal }, observer())
      if (output.result.status === 'rejected') throw output.result.reason
      expect(execute).toHaveBeenCalledOnce()
      expect(inspect.mock.calls.map(([, invocation]) => invocation)).toEqual(explicit
        ? [expect.objectContaining({ name: 'query', sourceAlias: 'user' }), expect.objectContaining({ name: 'query', sourceAlias: 'user' })]
        : [undefined, undefined])
    } finally { await instance.dispose(); database.close() }
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    'retains %s structured review usage through native production execution and SQLite', async protocol => {
    projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), sourceFolders: [testPaths.root], codingMode: true,
      capabilities: { ...structuredClone(defaultCapabilities), toolMode: 'selected', tools: [], memory: false, skills: { mode: 'off', project: false, entries: [] } } })
    const snapshot = { ...previewConfig(), subagents: [] }
    snapshot.providers[0].protocol = protocol
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const database = openDatabase()
    const thread = configuredThread(database, { title: 'Review' })
    const git = vi.spyOn(gitChanges, 'queryGitChanges').mockResolvedValue({ sourceFolder: testPaths.root, repositoryRoot: testPaths.root, scope: 'workspace',
      head: 'a'.repeat(40), baseline: 'a'.repeat(40), version: 'b'.repeat(64), fileCount: 1, hasMore: false,
      files: [{ path: `${testPaths.root}/example.ts`, relativePath: 'example.ts', status: 'M', source: 'tracked', patchTruncated: false, patch: createPatch('example.ts', 'old\n', 'new\n') }] })
    let fetch: ReturnType<typeof vi.spyOn> | undefined
    try {
      const scope = await captureCodeReview(database.readModel, { kind: 'git', projectId: thread.projectId, sourceFolder: testPaths.root, scope: 'workspace', version: 'b'.repeat(64) }, thread.projectId)
      const format = codeReviewToolDeclaration(scope.id)
      const report = { scope_id: scope.id, summary: 'No confirmed defect', findings: [], limitations: [] }
      fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const payload = JSON.parse(String(init?.body)) as { tools: Array<{ name?: string; function?: { name?: string } }>; tool_choice: unknown }
        expect(payload.tools.filter(tool => (tool.name ?? tool.function?.name) === format.function.name)).toHaveLength(1)
        expect(payload.tool_choice).toEqual(protocol === 'anthropic_messages' ? { type: 'any' } : 'required')
        const response = protocol === 'anthropic_messages'
          ? { id: 'review-response', type: 'message', role: 'assistant', model: 'preview-model',
              content: [{ type: 'tool_use', id: 'report-call', name: format.function.name, input: report }],
              stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 80000, output_tokens: 50 } }
          : protocol === 'openai_responses'
            ? { id: 'review-response', object: 'response', created_at: 1, status: 'completed', model: 'preview-model',
                output: [{ id: 'report-item', type: 'function_call', call_id: 'report-call', name: format.function.name,
                  arguments: JSON.stringify(report), status: 'completed' }],
                usage: { input_tokens: 80000, output_tokens: 50, total_tokens: 80050 } }
            : { id: 'review-response', object: 'chat.completion', created: 1, model: 'preview-model',
                choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '',
                  tool_calls: [{ id: 'report-call', type: 'function', function: { name: format.function.name, arguments: JSON.stringify(report) } }] } }],
                usage: { prompt_tokens: 80000, completion_tokens: 50, total_tokens: 80050 } }
        return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })
      })
      const userMessage: ConversationMessage = { id: 'review-input', kind: 'user', content: codeReviewPrompt(scope),
        context: { runId: 'review-run', displayText: 'Code review', reviewScope: scope } }
      database.runs.createRun({ threadId: thread.id, runId: 'review-run', operation: 'agent', message: { id: userMessage.id!, value: userMessage } })
      expect(database.runs.readRunInput({ threadId: thread.id, runId: 'review-run' })?.value.context?.reviewScope).toEqual(scope)
      expect(simpleConversationHistory([userMessage])[0].content).toEqual(userMessage.content)
      expect(presentConversationMessage(userMessage, 'review-input').content).toEqual([{ type: 'text', text: userMessage.content }])
      const instance = await createConversationInstance(thread, database.resources, snapshot, { requestId: 'review-run', prepareWorkspace: false, review: scope }, database.execution)
      try {
        const result = await instance.execution.execute('input', { threadId: thread.id, runId: 'review-run', signal: new AbortController().signal }, observer())
        expect(result.result.status).toBe('fulfilled')
        const state = database.runs.store.load(thread.id)!, values = conversationContextSource(state, database.runs.store)
        const messages = values.messages
        expect(presentConversationMessage(messages.at(-1)!, 'final').codeReview?.report).toEqual(report)
        expect(messages.at(-1)!.usage).toBeUndefined()
        const status = await instance.context.projectedStatus(values)
        expect(status.serverUsage).toMatchObject({ inputTokens: 80000, outputTokens: 50, totalTokens: 80050 })
        const providerIndex = messages.findIndex(message => message.kind === 'assistant' && message.usage)
        expect(providerIndex).toBeGreaterThan(0)
        expect(status.currentContextTokens).toBe(80000 + countConversationTokens(messages.slice(providerIndex), [], { protocol }))
        for (const message of messages.filter(message => message.kind === 'assistant')) {
          expect(message.context?.runId).toBe('review-run')
          expect(message.context?.projectRulesReceipt).toMatchObject({ runId: 'review-run' })
        }
        const nextRunStatus = await projectConversationContextStatus(thread, database.resources, snapshot, values, {})
        expect(nextRunStatus.serverUsage).toMatchObject({ inputTokens: 80000, outputTokens: 50, totalTokens: 80050 })
      } finally { await instance.dispose() }
    } finally { fetch?.mockRestore(); git.mockRestore(); database.close() }
  })
  it('recomputes the selected protocol without building a model, connecting MCP or changing history', async () => {
    const snapshot = previewConfig()
    snapshot.mcpServers = [{ id: 'preview-mcp', index: 0, name: 'Preview MCP', enabled: true,
      type: 'stdio', command: 'must-not-start', args: [], env: {}, workingDir: '', timeoutMs: 1000, url: '' }]
    snapshot.providers[0].protocol = 'anthropic_messages'
    appConfigMocks.getAppConfigSnapshot.mockImplementation(async () => structuredClone(snapshot))
    const database = openDatabase(), thread = configuredThread(database)
    const factory = vi.spyOn(conversationModel, 'createConversationModel')
    const connect = vi.spyOn(mcpRuntimeService, 'getCachedMcpRuntime')
    const before = database.runs.store.readHistory(thread.id)
    const messages: ConversationMessage[] = [{ kind: 'user', content: 'Inspect' },
      { kind: 'assistant', content: '', calls: [{ id: 'capture', name: 'view_image', args: {} }] },
      { kind: 'tool', resultFor: 'capture', name: 'view_image', content: [
        { type: 'text', text: 'Image metadata '.repeat(1000) },
        { type: 'image_url', image_url: { url: 'https://example.test/image.png' } }
      ] }]
    try {
      const first = await projectConversationContextStatus(thread, database.resources, snapshot, { messages }, {})
      snapshot.providers[0].protocol = 'openai_chat_completions'
      const next = await projectConversationContextStatus(thread, database.resources, snapshot, { messages }, {})
      expect(next.estimatedInputTokens).toBeGreaterThan(first.estimatedInputTokens + 2000)
      expect(next.modelContextKey).not.toBe(first.modelContextKey)
      expect(factory).not.toHaveBeenCalled()
      expect(connect).not.toHaveBeenCalled()
      expect(database.runs.store.readHistory(thread.id)).toEqual(before)
      expect(database.messages.activities.getLatestRunForThread(thread.id)).toBeNull()
    } finally { database.close() }
  })

  it.each([true, false])('includes management schemas in readonly preview with background tools %s', async backgroundTools => {
    const snapshot = previewConfig(), project = minimalProject()
    project.capabilities.backgroundTools = backgroundTools
    projectStoreMocks.getProject.mockResolvedValue(project)
    const database = openDatabase(), thread = configuredThread(database)
    const managedCalls = new ManagedCallService(database.managed, database.results)
    if (!backgroundTools) {
      const run = createRun(database, thread.id, 'managed-call-run', 'Work')
      const id = '11111111-1111-8111-8111-111111111111'
      database.managed.createManagedCall({ id, threadId: thread.id, runId: run.id, kind: 'http', summary: 'Needs supervision' })
      database.managed.markManagedCallDetached(id, thread.id)
      database.managed.finishManagedCall({ callId: id, threadId: thread.id, status: 'completed', result: 'done' })
      database.runs.requestCancellation({ threadId: thread.id, runId: run.id })
      database.runs.completeCancellation({ threadId: thread.id, runId: run.id })
    }
    const factory = vi.spyOn(conversationModel, 'createConversationModel')
    const connect = vi.spyOn(mcpRuntimeService, 'getCachedMcpRuntime')
    const definitions = vi.spyOn(runtimeTools, 'runtimeToolDefinitions')
    const values = { messages: [{ kind: 'user' as const, content: 'Inspect background work.' }] }
    const before = database.runs.store.readHistory(thread.id)
    try {
      const preview = await projectConversationContextStatus(thread, database.resources, snapshot, values, { managedCalls })
      expect(factory).not.toHaveBeenCalled()
      expect(connect).not.toHaveBeenCalled()
      expect(database.runs.store.readHistory(thread.id)).toEqual(before)
      expect((await definitions.mock.results.at(-1)!.value).map((tool: { name: string }) => tool.name)).toEqual([
        'read_call', 'read_call_output', 'wait_call', 'cancel_call'
      ])
      createRun(database, thread.id, 'inspect', 'Inspect background work.')
      const instance = await createConversationInstance(thread, database.resources, snapshot,
        { requestId: 'inspect', prepareWorkspace: false, managedCalls }, database.execution)
      try {
        const actual = await instance.context.projectedStatus(values)
        expect(preview.breakdown?.toolDefinitionTokens).toBeGreaterThan(0)
        expect(preview.breakdown?.toolDefinitionTokens).toBe(actual.breakdown?.toolDefinitionTokens)
        expect(preview.estimatedInputTokens).toBe(actual.estimatedInputTokens)
      } finally { await instance.dispose() }
    } finally { await managedCalls.shutdown(); database.close() }
  })

  it('includes the native planning tool in live and reconstructed context estimates', async () => {
    const snapshot = previewConfig(), project = minimalProject()
    project.capabilities.planning = true
    projectStoreMocks.getProject.mockResolvedValue(project)
    const database = openDatabase(), thread = configuredThread(database)
    createRun(database, thread.id, 'planning-context', 'Verify the next model request.')
    const onContextStatus = vi.fn()
    const messages: ConversationMessage[] = [{ kind: 'user', content: 'Verify the next model request.' }]
    const instance = await createConversationInstance(thread, database.resources, snapshot, {
      requestId: 'planning-context', prepareWorkspace: false, onContextStatus, providerFetch: async () => completedResponse()
    }, database.execution)
    try {
      const result = await instance.execution.execute('input', { threadId: thread.id, runId: 'planning-context', signal: new AbortController().signal }, observer())
      expect(result.result.status).toBe('fulfilled')
      const prepared = onContextStatus.mock.lastCall![0]
      expect(prepared.breakdown.toolDefinitionTokens).toBeGreaterThan(0)
      expect(prepared.estimatedInputTokens).toBeGreaterThan(prepared.breakdown.messageTokens)
      expect(prepared.estimatedInputTokens).toBe(Object.values(prepared.breakdown as Record<string, number>).reduce((sum, tokens) => sum + tokens, 0))
      const preview = await instance.context.projectedStatus({ messages })
      expect(preview.breakdown?.toolDefinitionTokens).toBe(prepared.breakdown.toolDefinitionTokens)
      const reconstructed = await projectConversationContextStatus(thread, database.resources, snapshot, { messages }, {})
      expect(reconstructed.estimatedInputTokens).toBe(preview.estimatedInputTokens)
    } finally { await instance.dispose(); database.close() }
  })

  it.each(['selection', 'parameters', 'retry', 'deleted', 'invalid', 'tool-capability', 'small-window'] as const)(
    'reads %s changes before the next native request in the same run', async change => {
      const snapshot = previewConfig()
      const second = { ...snapshot.providers[0].models[0], id: 'second-model', model: 'second-model', parameters: { temperature: 0.2 } }
      snapshot.providers[0].models.push(second)
      appConfigMocks.getAppConfigSnapshot.mockImplementation(async () => structuredClone(snapshot))
      const database = openDatabase(), thread = configuredThread(database)
      const runId = `live-model-${change}`
      createRun(database, thread.id, runId, 'Continue after updating the plan.')
      const observed: Array<{ model: string; temperature?: number }> = []
      const providerFetch: typeof fetch = async (_url, init) => {
        observed.push(JSON.parse(String(init?.body)))
        if (observed.length > 1) return completedResponse()
        if (change === 'selection' || change === 'retry') database.updateThread(thread.id, { modelConfigId: second.id, modelParameterPresetId: null })
        if (change === 'retry') return Response.json({ error: { message: 'Temporarily unavailable' } }, { status: 503 })
        if (change === 'parameters') snapshot.providers[0].models[0].parameters = { temperature: 0.7 }
        if (change === 'deleted') snapshot.providers[0].models.shift()
        if (change === 'invalid') snapshot.providers[0].models[0].model = ''
        if (change === 'tool-capability') snapshot.providers[0].models[0].capabilities.toolUse = false
        if (change === 'small-window') {
          snapshot.providers[0].models[0].maxContextTokens = 4100
          snapshot.providers[0].models[0].maxOutputTokens = 4090
        }
        return Response.json({ id: 'plan-response', object: 'chat.completion', created: 1, model: 'preview-model',
          choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: 'Updating the plan.',
            tool_calls: [{ id: 'plan', type: 'function', function: { name: 'write_todos', arguments: JSON.stringify({ todos: [{ content: 'Finish the reply', status: 'in_progress' }] }) } }] } }] })
      }
      const instance = await createConversationInstance(thread, database.resources, snapshot, { requestId: runId, prepareWorkspace: false, providerFetch }, database.execution)
      try {
        const result = await instance.execution.execute('input', { threadId: thread.id, runId, signal: new AbortController().signal }, observer())
        const state = database.runs.store.load(thread.id)!
        if (change === 'selection' || change === 'parameters' || change === 'retry') {
          expect(result.result.status).toBe('fulfilled')
          expect(observed).toHaveLength(2)
          expect(observed[0].model).toBe('preview-model')
          expect(observed[1]).toMatchObject(change !== 'parameters'
            ? { model: 'second-model', temperature: 0.2 } : { model: 'preview-model', temperature: 0.7 })
          expect(state.messages.at(-1)?.value.content).toBe('Done')
          expect(state.context.modelCalls).toBe(change === 'retry' ? 1 : 2)
        } else {
          expect(result.result.status).toBe('rejected')
          expect(observed).toHaveLength(1)
          expect(state.messages.some(message => contentText(conversationContentBlocks(message.value)) === 'Updating the plan.')).toBe(true)
          expect(state.messages.some(message => message.value.kind === 'tool')).toBe(true)
        }
      } finally { await instance.dispose(); database.close() }
    })

  it('previews current project capabilities after a completed run', async () => {
    const snapshot = previewConfig(), project = minimalProject()
    appConfigMocks.getAppConfigSnapshot.mockImplementation(async () => structuredClone(snapshot))
    projectStoreMocks.getProject.mockImplementation(async () => structuredClone(project))
    const database = openDatabase(), thread = configuredThread(database)
    const runtime = new NativeAgentRuntime(database, testPaths.root, { push: vi.fn() },
      { prepareWorkspace: false, providerFetch: vi.fn(async () => completedResponse()) })
    try {
      const first = await runtime.submitRunWithAttachments({ threadId: thread.id, runId: 'previous-project-config', submissionId: '11111111-1111-4111-8111-111111111111', text: 'Hello' })
      expect((await first.handle!.completed).status).toBe('completed')
      await first.handle!.drained
      expect(database.runs.getRunConfiguration({ threadId: thread.id, runId: 'previous-project-config' })!.capabilities.planning).toBe(false)
      project.capabilities.planning = true
      snapshot.providers[0].models[0].model = 'changed-model'
      const preview = await runtime.getContextStatus(thread.id)
      const state = database.runs.store.load(thread.id)!
      const values = conversationContextSource(state, database.runs.store)
      createRun(database, thread.id, 'current-project-config', 'Continue')
      const second = await createConversationInstance(database.getThread(thread.id)!, database.resources, snapshot,
        { requestId: 'current-project-config', prepareWorkspace: false }, database.execution)
      try {
        const actual = await second.context.projectedStatus(values)
        expect(preview?.breakdown?.toolDefinitionTokens).toBeGreaterThan(0)
        expect(preview?.breakdown?.toolDefinitionTokens).toBe(actual.breakdown?.toolDefinitionTokens)
        expect(preview?.estimatedInputTokens).toBe(actual.estimatedInputTokens)
        expect(database.runs.getRunConfiguration({ threadId: thread.id, runId: 'current-project-config' })!.capabilities.planning).toBe(true)
      } finally { await second.dispose() }
    } finally { await runtime.shutdown(); database.close() }
  })

  it.each([false, true].flatMap(codingMode => (['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)
    .map(protocol => ({ codingMode, protocol }))))('reuses saved usage in $protocol previews with coding=$codingMode', async ({ codingMode, protocol }) => {
    const directory = await mkdtemp(join(testPaths.root, 'usage-preview-'))
    await writeFile(join(directory, 'AGENTS.md'), 'Preserve the project conventions.')
    const snapshot = previewConfig(), project = minimalProject()
    snapshot.providers[0].protocol = protocol
    if (protocol === 'openai_responses') snapshot.providers[0].models[0].parameters = { instructions: 'Additional request instructions.' }
    appConfigMocks.getAppConfigSnapshot.mockImplementation(async () => structuredClone(snapshot))
    projectStoreMocks.getProject.mockResolvedValue({ ...project, sourceFolders: [directory], codingMode,
      capabilities: { ...project.capabilities, planning: true } })
    const database = openDatabase(), thread = configuredThread(database)
    createRun(database, thread.id, 'usage-run', 'Verify the current request.')
    const instance = await createConversationInstance(thread, database.resources, snapshot, {
      requestId: 'usage-run', prepareWorkspace: false, providerFetch: async () => usageResponse(protocol, 10000, 20)
    }, database.execution)
    try {
      const result = await instance.execution.execute('input', { threadId: thread.id, runId: 'usage-run', signal: new AbortController().signal }, observer())
      expect(result.result.status).toBe('fulfilled')
      const values = conversationContextSource(database.runs.store.load(thread.id)!, database.runs.store)
      for (const projected of [await instance.context.projectedStatus(values),
        await projectConversationContextStatus(thread, database.resources, snapshot, values, {})]) {
        expect(projected.estimatedInputTokens).toBeLessThan(10000)
        expect(projected.currentContextTokens).toBeGreaterThan(10000)
      }
    } finally { await instance.dispose(); database.close() }
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    'rejects calibrated over-capacity %s input before another provider request', async protocol => {
      const snapshot = previewConfig(), selected = snapshot.providers[0].models[0]
      snapshot.providers[0].protocol = protocol
      selected.contextCompressionEnabled = true
      appConfigMocks.getAppConfigSnapshot.mockImplementation(async () => structuredClone(snapshot))
      projectStoreMocks.getProject.mockResolvedValue(minimalProject())
      const database = openDatabase(), thread = configuredThread(database)
      const providerFetch = vi.fn(async () => usageResponse(protocol, 8000, 1)), onContextStatus = vi.fn()
      createRun(database, thread.id, 'before-capacity-change', '分析：' + '中'.repeat(6000))
      const first = await createConversationInstance(thread, database.resources, snapshot, {
        requestId: 'before-capacity-change', prepareWorkspace: false, providerFetch, onContextStatus
      }, database.execution)
      try {
        try {
          const initial = await first.execution.execute('input', { threadId: thread.id, runId: 'before-capacity-change', signal: new AbortController().signal }, observer())
          expect(initial.result.status).toBe('fulfilled')
          expect(providerFetch).toHaveBeenCalledOnce()
        } finally { await first.dispose() }
        selected.maxContextTokens = 10000
        selected.contextCompressionEnabled = false
        const values = conversationContextSource(database.runs.store.load(thread.id)!, database.runs.store)
        const preview = await projectConversationContextStatus(thread, database.resources, snapshot, values, {})
        expect(preview.currentContextTokens).toBeGreaterThan(8000)
        expect(preview.inputCapacityTokens).toBe(6000)
        expect(preview.estimatedInputTokens).toBeLessThan(6000)
        createRun(database, thread.id, 'after-capacity-change', 'Continue')
        const second = await createConversationInstance(thread, database.resources, snapshot, {
          requestId: 'after-capacity-change', prepareWorkspace: false, providerFetch, onContextStatus
        }, database.execution)
        try {
          const result = await second.execution.execute('input', { threadId: thread.id, runId: 'after-capacity-change', signal: new AbortController().signal }, observer())
          expect(result.result.status).toBe('rejected')
          if (result.result.status === 'rejected') expect(String(result.result.reason)).toContain('required context does not fit')
          expect(providerFetch).toHaveBeenCalledOnce()
          const status = onContextStatus.mock.lastCall![0]
          expect(status.currentContextTokens).toBeGreaterThan(8000)
          expect(status.inputCapacityTokens).toBe(6000)
        } finally { await second.dispose() }
      } finally { database.close() }
    })

  it('rejects invalid server tool settings even when tool use is disabled', async () => {
    const snapshot = previewConfig(false)
    snapshot.providers[0].protocol = 'openai_responses'
    snapshot.providers[0].models[0].parameters = { tools: [{}] }
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const database = openDatabase(), thread = configuredThread(database), providerFetch = vi.fn(async () => completedResponse())
    createRun(database, thread.id, 'invalid-server-tool', 'Hello')
    const instance = await createConversationInstance(thread, database.resources, snapshot,
      { requestId: 'invalid-server-tool', prepareWorkspace: false, providerFetch }, database.execution)
    try {
      const result = await instance.execution.execute('input', { threadId: thread.id, runId: 'invalid-server-tool', signal: new AbortController().signal }, observer())
      expect(result.result.status).toBe('rejected')
      if (result.result.status === 'rejected') expect(String(result.result.reason)).toContain('invalid tool parameters')
      expect(providerFetch).not.toHaveBeenCalled()
    } finally { await instance.dispose(); database.close() }
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    'continues with unknown %s tool outcomes without fabricating saved results', async protocol => {
      const snapshot = previewConfig()
      snapshot.providers[0].protocol = protocol
      appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
      const history: ConversationMessage[] = [{ id: 'request', kind: 'user', content: 'Write the file' },
        { id: 'unrecorded', kind: 'assistant', content: '', calls: [{ id: 'unrecorded-call', name: 'write_file', args: { path: 'a.txt' } }] },
        { id: 'unpaired', kind: 'tool', resultFor: 'orphan-call', content: 'ORIGINAL_UNPAIRED_EVIDENCE' }]
      const { database, thread } = openHistoryDatabase(history)
      const bodies: Record<string, unknown>[] = []
      const providerFetch: typeof fetch = async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return usageResponse(protocol, 10, 5)
      }
      createRun(database, thread.id, 'unknown-outcome', 'Continue')
      const instance = await createConversationInstance(thread, database.resources, snapshot,
        { requestId: 'unknown-outcome', prepareWorkspace: false, providerFetch }, database.execution)
      try {
        const result = await instance.execution.execute('input', { threadId: thread.id, runId: 'unknown-outcome', signal: new AbortController().signal }, observer())
        expect(result.result.status).toBe('fulfilled')
        expect(bodies).toHaveLength(1)
        if (protocol === 'anthropic_messages') {
          expect(bodies[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' })
          expect(bodies[0].system).toEqual(expect.arrayContaining([expect.objectContaining({ cache_control: { type: 'ephemeral' } })]))
        } else expect(bodies[0]).not.toHaveProperty('cache_control')
        expect(JSON.stringify(bodies[0])).toContain('outcome is unknown')
        expect(JSON.stringify(bodies[0])).toContain('unrecorded-call')
        expect(JSON.stringify(bodies[0])).not.toContain('ORIGINAL_UNPAIRED_EVIDENCE')
        const stored = database.runs.store.readHistory(thread.id)!.messages.map(message => message.value)
        expect(stored.find(message => message.id === 'unpaired')).toEqual(history[2])
        expect(stored.some(message => message.context?.unrecordedResult)).toBe(false)
        expect(stored.find(message => message.id === 'unrecorded')).toEqual(history[1])
      } finally { await instance.dispose(); database.close() }
    })

  it('allows text-only vision after an earlier tool image has been consumed', async () => {
    const snapshot = previewConfig()
    snapshot.providers[0].models[0].capabilities.vision = false
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const history: ConversationMessage[] = [{ kind: 'user', content: 'Inspect the picture.' },
      { kind: 'assistant', content: '', calls: [{ id: 'image', name: 'view_image', args: {} }] },
      { id: 'image-result', kind: 'tool', resultFor: 'image', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
      { kind: 'assistant', content: 'The image shows a chart.' }]
    const { database, thread } = openHistoryDatabase(history)
    const providerFetch = vi.fn(async (_url, init) => {
      expect(String(init?.body)).not.toContain('data:image/png')
      return completedResponse()
    })
    createRun(database, thread.id, 'consumed-image', 'Now explain the result in text.')
    const instance = await createConversationInstance(thread, database.resources, snapshot,
      { requestId: 'consumed-image', prepareWorkspace: false, providerFetch }, database.execution)
    try {
      const result = await instance.execution.execute('input', { threadId: thread.id, runId: 'consumed-image', signal: new AbortController().signal }, observer())
      expect(result.result.status).toBe('fulfilled')
      expect(providerFetch).toHaveBeenCalledOnce()
      expect(database.runs.store.readHistory(thread.id)!.messages.find(message => message.id === 'image-result')?.value).toEqual(history[2])
    } finally { await instance.dispose(); database.close() }
  })

  it.each([false, true])('checks tool capability against the saved summary boundary (compressed: %s)', async compressed => {
    const snapshot = previewConfig(false)
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const history: ConversationMessage[] = [{ id: 'old-human', kind: 'user', content: 'Read the file.' },
      { id: 'old-ai', kind: 'assistant', content: '', calls: [{ id: 'read', name: 'read_file', args: {} }] },
      { id: 'old-tool', kind: 'tool', resultFor: 'read', content: 'Earlier file contents.' },
      { id: 'old-result', kind: 'assistant', content: 'The file has been read.' }]
    const { database, thread } = openHistoryDatabase(history, { cutoffIndex: compressed ? 4 : 1, content: 'Earlier file work.' })
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
    const providerFetch: typeof fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return completedResponse() }
    createRun(database, thread.id, 'summary-capability', 'Explain the result in text.')
    const instance = await createConversationInstance(thread, database.resources, snapshot,
      { requestId: 'summary-capability', prepareWorkspace: false, providerFetch }, database.execution)
    try {
      expect(database.runs.store.readHistory(thread.id)!.context.summary?.cutoffIndex).toBe(compressed ? 4 : 1)
      const result = await instance.execution.execute('input', { threadId: thread.id, runId: 'summary-capability', signal: new AbortController().signal }, observer())
      if (compressed) {
        expect(result.result.status).toBe('fulfilled')
        expect(bodies).toHaveLength(1)
        expect(bodies[0].messages.some(message => message.role === 'tool')).toBe(false)
        expect(JSON.stringify(bodies[0])).toContain('Earlier file work.')
        expect(JSON.stringify(bodies[0])).toContain('Explain the result in text.')
      } else {
        expect(result.result.status).toBe('rejected')
        if (result.result.status === 'rejected') expect(String(result.result.reason)).toContain('does not support the tool context')
        expect(bodies).toHaveLength(0)
      }
      expect(database.runs.store.readHistory(thread.id)!.messages.find(message => message.id === 'old-tool')?.value).toEqual(history[2])
    } finally { await instance.dispose(); database.close() }
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'].flatMap(protocol =>
    [false, true].map(summarized => ({ protocol: protocol as ModelProtocol, summarized }))))(
    'projects moved simple-chat history before counting or sending ($protocol/summary=$summarized)', async ({ protocol, summarized }) => {
      const snapshot = previewConfig()
      snapshot.providers[0].protocol = protocol
      appConfigMocks.getAppConfigSnapshot.mockImplementation(async () => structuredClone(snapshot))
      const simple: Project = { id: 'plain-chat', name: 'Plain chat', kind: 'simple_chat', pinned: false,
        collapsed: false, prompt: 'Plain system', createdAt: '', updatedAt: '' }
      projectStoreMocks.getProject.mockImplementation(async id => id === simple.id ? simple : defaultWorkspaceProject())
      const history: ConversationMessage[] = [{ id: 'old-user', kind: 'user', content: 'Inspect with detailed Skill instructions', context: { displayText: '/inspect visible request' } },
        { id: 'old-call', kind: 'assistant', content: 'Reading', calls: [{ id: 'read-call', name: 'read_file', args: { path: 'file.txt' } }] },
        { id: 'old-tool', kind: 'tool', resultFor: 'read-call', content: 'Large tool output '.repeat(1000) },
        { id: 'old-answer', kind: 'assistant', content: 'Inspected' }]
      const { database, thread: original } = openHistoryDatabase(history, summarized ? { cutoffIndex: history.length, content: 'Previous inspection' } : undefined)
      const thread = database.updateThread(original.id, { projectId: simple.id })
      const current: ConversationMessage = { id: 'current', kind: 'user', content: 'CURRENT REQUEST', context: { runId: 'moved-chat' } }
      const path = join(testPaths.root, `moved-chat-${protocol}-${summarized}.txt`)
      await writeFile(path, 'Attached evidence '.repeat(20))
      vi.spyOn(database.resources, 'listAttachmentsForThread').mockReturnValue([{ id: 'attachment', threadId: thread.id,
        messageId: 'old-user', runId: 'old-run', name: 'evidence.txt', mimeType: 'text/plain', size: 360,
        kind: 'text', path, available: true, textTruncated: false, contextPolicy: 'conversation', createdAt: '' }])
      const observed = observeModelRequests(), onContextStatus = vi.fn()
      database.runs.createRun({ threadId: thread.id, runId: 'moved-chat', operation: 'agent', message: { id: 'current', value: current } })
      const instance = await createConversationInstance(thread, database.resources, snapshot,
        { requestId: 'moved-chat', prepareWorkspace: false, onContextStatus, providerFetch: async () => usageResponse(protocol, 10, 5) }, database.execution)
      try {
        const values = conversationContextSource({ threadId: thread.id, ...database.runs.store.readHistory(thread.id)! }, database.runs.store)
        values.messages.push(current)
        const preview = await instance.context.projectedStatus(values)
        const readonlyPreview = await projectConversationContextStatus(thread, database.resources, snapshot, values, {})
        const result = await instance.execution.execute('input', { threadId: thread.id, runId: 'moved-chat', signal: new AbortController().signal }, observer())
        expect(result.result.status).toBe('fulfilled')
        const delivered = observed.requests.map(request => request.messages)
        expect(delivered).toHaveLength(1)
        expect(delivered[0].some(message => message.id === current.id)).toBe(true)
        expect(delivered[0].some(message => message.kind === 'tool')).toBe(false)
        expect(delivered[0].filter(message => message.kind === 'assistant').every(message => !message.calls?.length)).toBe(true)
        if (summarized) {
          expect(delivered[0].some(message => message.content === 'Previous inspection')).toBe(true)
          expect(delivered[0].some(message => message.id === 'old-user')).toBe(false)
        }
        const actual = countConversationTokens(delivered[0], [], { protocol })
        expect(preview.estimatedInputTokens).toBe(actual)
        expect(readonlyPreview.estimatedInputTokens).toBe(actual)
        expect(Object.values(preview.breakdown!).reduce((sum, value) => sum + value, 0)).toBe(actual)
        expect(onContextStatus.mock.lastCall?.[0].breakdown.attachmentTokens).toBe(preview.breakdown?.attachmentTokens)
        expect(preview.breakdown!.attachmentTokens > 0).toBe(!summarized)
        expect(database.runs.store.readHistory(thread.id)!.messages.find(message => message.id === 'old-tool')?.value).toEqual(history[2])
      } finally { await instance.dispose(); database.close() }
    })

  it.each([false, true].flatMap(compressed => [false, true].map(reportContext => ({ compressed, reportContext }))))(
    'checks image capability against the saved summary boundary (compressed: $compressed, context status: $reportContext)', async ({ compressed, reportContext }) => {
      const snapshot = previewConfig()
      snapshot.providers[0].models[0].capabilities.vision = false
      appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
      const history: ConversationMessage[] = [{ id: 'old-human', kind: 'user', content: 'Read the image.' },
        { id: 'old-result', kind: 'assistant', content: 'It is a chart.' }]
      const { database, thread } = openHistoryDatabase(history, { cutoffIndex: compressed ? 2 : 0, content: 'Earlier chart observations.' })
      vi.spyOn(database.resources, 'listAttachmentsForThread').mockReturnValue([{
        id: 'old-image', threadId: thread.id, messageId: 'old-human', runId: 'old-run',
        name: 'earlier-chart.png', mimeType: 'image/png', size: 4, kind: 'image', path: 'unused.png',
        available: true, textTruncated: false, contextPolicy: 'conversation', createdAt: thread.createdAt
      }])
      const bodies: unknown[] = [], onContextStatus = vi.fn()
      const providerFetch: typeof fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return completedResponse() }
      createRun(database, thread.id, 'image-summary', 'Explain the result in text.')
      const instance = await createConversationInstance(thread, database.resources, snapshot,
        { requestId: 'image-summary', prepareWorkspace: false, providerFetch, ...(reportContext ? { onContextStatus } : {}) }, database.execution)
      try {
        const result = await instance.execution.execute('input', { threadId: thread.id, runId: 'image-summary', signal: new AbortController().signal }, observer())
        if (compressed) {
          expect(result.result.status).toBe('fulfilled')
          expect(bodies).toHaveLength(1)
          expect(JSON.stringify(bodies[0])).toContain('Earlier chart observations.')
          expect(JSON.stringify(bodies[0])).toContain('Explain the result in text.')
          expect(JSON.stringify(bodies[0])).not.toContain('Read the image.')
          if (reportContext) expect(onContextStatus.mock.calls[0][0]).toMatchObject({ compressionApplied: true, breakdown: { attachmentTokens: 0 } })
        } else {
          expect(result.result.status).toBe('rejected')
          if (result.result.status === 'rejected') expect(String(result.result.reason)).toContain('does not support the required image attachment')
          expect(bodies).toHaveLength(0)
        }
      } finally { await instance.dispose(); database.close() }
    })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    'keeps %s attachment usage for the active run and drops it before next-run compression', async protocol => {
      const snapshot = previewConfig()
      snapshot.providers[0].protocol = protocol
      Object.assign(snapshot.providers[0].models[0], { contextCompressionEnabled: true, contextCompressionThreshold: 0.08 })
      appConfigMocks.getAppConfigSnapshot.mockImplementation(async () => structuredClone(snapshot))
      projectStoreMocks.getProject.mockResolvedValue(minimalProject())
      const path = join(testPaths.root, `attachment-usage-${protocol}.txt`)
      await writeFile(path, 'Attachment evidence '.repeat(100))
      const database = openDatabase(), thread = configuredThread(database)
      createRun(database, thread.id, 'attachment-first', 'Read the attachment')
      vi.spyOn(database.resources, 'listAttachmentsForThread').mockReturnValue([{ id: 'attachment', threadId: thread.id,
        messageId: 'attachment-first:input', runId: 'attachment-first', name: 'evidence.txt', mimeType: 'text/plain', size: 2000,
        kind: 'text', path, available: true, textTruncated: false, contextPolicy: 'one_turn', createdAt: '' }])
      const bodies: unknown[] = [], onCompressionStart = vi.fn(() => 'unexpected-summary')
      const providerFetch: typeof fetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return usageResponse(protocol, 8000, 3) }
      try {
        const first = await createConversationInstance(thread, database.resources, snapshot,
          { requestId: 'attachment-first', prepareWorkspace: false, providerFetch, onCompressionStart }, database.execution)
        try {
          const result = await first.execution.execute('input', { threadId: thread.id, runId: 'attachment-first', signal: new AbortController().signal }, observer())
          expect(result.result.status).toBe('fulfilled')
          const values = conversationContextSource(database.runs.store.load(thread.id)!, database.runs.store)
          expect(JSON.stringify(bodies[0])).toContain('Attachment evidence')
          expect((await first.context.projectedStatus(values)).currentContextTokens).toBeGreaterThan(8000)
        } finally { await first.dispose() }
        const values = conversationContextSource(database.runs.store.load(thread.id)!, database.runs.store)
        const preview = await projectConversationContextStatus(thread, database.resources, snapshot, values, {})
        expect(preview.currentContextTokens).toBe(preview.estimatedInputTokens)
        expect(preview.currentContextTokens).toBeLessThan(8000)
        createRun(database, thread.id, 'attachment-next', 'Continue')
        const next = await createConversationInstance(thread, database.resources, snapshot,
          { requestId: 'attachment-next', prepareWorkspace: false, providerFetch, onCompressionStart }, database.execution)
        try {
          const result = await next.execution.execute('input', { threadId: thread.id, runId: 'attachment-next', signal: new AbortController().signal }, observer())
          expect(result.result.status).toBe('fulfilled')
        } finally { await next.dispose() }
        expect(bodies).toHaveLength(2)
        expect(JSON.stringify(bodies[1])).not.toContain('Attachment evidence')
        expect(onCompressionStart).not.toHaveBeenCalled()
      } finally { database.close() }
    })

  it('retains streaming Responses usage after the SDK adds image-generation transport options', async () => {
    const snapshot = previewConfig()
    snapshot.providers[0].protocol = 'openai_responses'
    Object.assign(snapshot.providers[0].models[0], { stream: true, parameters: { tools: [{ type: 'image_generation' }] } })
    appConfigMocks.getAppConfigSnapshot.mockImplementation(async () => structuredClone(snapshot))
    projectStoreMocks.getProject.mockResolvedValue(minimalProject())
    const providerFetch: typeof fetch = async (_url, init) => {
      expect(JSON.parse(String(init?.body)).tools).toEqual([{ type: 'image_generation', partial_images: 1 }])
      const event = { type: 'response.completed', response: { id: 'response', object: 'response', created_at: 1,
        model: 'preview-model', status: 'completed', output: [{ id: 'answer', type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'Done', annotations: [] }] }], usage: { input_tokens: 8000, output_tokens: 1, total_tokens: 8001 } } }
      return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    }
    const database = openDatabase(), thread = configuredThread(database)
    createRun(database, thread.id, 'image-generation', 'Draw a square')
    const instance = await createConversationInstance(thread, database.resources, snapshot,
      { requestId: 'image-generation', prepareWorkspace: false, providerFetch }, database.execution)
    try {
      const result = await instance.execution.execute('input', { threadId: thread.id, runId: 'image-generation', signal: new AbortController().signal }, observer())
      expect(result.result.status).toBe('fulfilled')
      const values = conversationContextSource(database.runs.store.load(thread.id)!, database.runs.store)
      const preview = await projectConversationContextStatus(thread, database.resources, snapshot, values, {})
      expect(preview.estimatedInputTokens).toBeLessThan(8000)
      expect(preview.currentContextTokens).toBeGreaterThanOrEqual(8000)
    } finally { await instance.dispose(); database.close() }
  })

  it('compresses history when recalled memory pushes the complete request over its budget', async () => {
    const snapshot = previewConfig(), selected = snapshot.providers[0].models[0], project = minimalProject()
    selected.contextCompressionEnabled = true
    appConfigMocks.getAppConfigSnapshot.mockImplementation(async () => structuredClone(snapshot))
    project.capabilities.memory = true
    projectStoreMocks.getProject.mockResolvedValue(project)
    const { database, thread } = openHistoryDatabase([{ id: 'old-user', kind: 'user', content: 'h'.repeat(4400) },
      { id: 'old-answer', kind: 'assistant', content: 'a'.repeat(4400) }])
    const relevant = vi.spyOn(database.resources.memoryStore, 'relevantMemories').mockResolvedValue([{
      id: 'memory', scope: 'project', projectId: thread.projectId, kind: 'fact', importance: 1,
      content: 'Remember the project constraint. ' + 'm'.repeat(4400), keywords: [], origin: 'user',
      createdAt: '2026-09-24T00:00:00.000Z', updatedAt: '2026-09-24T00:00:00.000Z'
    }])
    createRun(database, thread.id, 'memory-compression', 'Continue')
    const current = database.runs.readRunInput({ threadId: thread.id, runId: 'memory-compression' })!.value
    const source = conversationContextSource({ threadId: thread.id, ...database.runs.store.readHistory(thread.id)! }, database.runs.store)
    source.messages.push(current)
    const observed = observeModelRequests(), summaries: unknown[] = []
    const providerFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      if (body.messages.length === 1) { summaries.push(body); return completedResponse('Condensed earlier history.') }
      return completedResponse('Finished')
    }
    try {
      const before = await projectConversationContextStatus(thread, database.resources, snapshot, source, {})
      relevant.mockResolvedValueOnce([])
      const withoutRecall = await projectConversationContextStatus(thread, database.resources, snapshot, source, {})
      expect(before.estimatedInputTokens).toBeGreaterThan(withoutRecall.estimatedInputTokens + 1000)
      const capacity = withoutRecall.estimatedInputTokens + 500
      selected.maxContextTokens = capacity + selected.maxOutputTokens
      selected.contextCompressionThreshold = (withoutRecall.estimatedInputTokens + 250) / capacity
      const instance = await createConversationInstance(thread, database.resources, snapshot,
        { requestId: 'memory-compression', prepareWorkspace: false, providerFetch,
          ...createCompressionTracking(database.summaries, 'memory-compression') }, database.execution)
      try {
        const result = await instance.execution.execute('input', { threadId: thread.id, runId: 'memory-compression', signal: new AbortController().signal }, observer())
        if (result.result.status === 'rejected') throw result.result.reason
        expect(result.result.status).toBe('fulfilled')
        expect(summaries).toHaveLength(1)
        expect(observed.requests).toHaveLength(1)
        const delivered = observed.requests[0].messages
        expect(contentText(conversationContentBlocks(delivered[0]))).toContain('Remember the project constraint.')
        expect(delivered.some(message => message.id === 'old-user')).toBe(false)
        expect(delivered.some(message => contentText(conversationContentBlocks(message)).includes('Condensed earlier history.'))).toBe(true)
        const state = database.runs.store.load(thread.id)!
        expect(state.context.summary).toMatchObject({ cutoffIndex: 2 })
        expect(state.messages.at(-1)!.value.context?.requestKey).toBe(conversationRequestKey({
          messages: delivered.slice(1), systemMessage: delivered[0], tools: [], protocol: 'openai_chat_completions'
        }))
      } finally { await instance.dispose() }
    } finally { database.close() }
  })

  it.each(['parameters', 'displayName', 'deleted', 'in-flight', 'selection', 'initial-model'] as const)(
    'uses current settings when automatic compression changes during %s', async change => {
      const snapshot = previewConfig()
      Object.assign(snapshot.providers[0].models[0], { contextCompressionEnabled: true, contextCompressionThreshold: 0.1 })
      snapshot.providers[0].models.push({ ...structuredClone(snapshot.providers[0].models[0]), id: 'second-model', model: 'second-model' })
      appConfigMocks.getAppConfigSnapshot.mockImplementation(async () => structuredClone(snapshot))
      const { database, thread } = openHistoryDatabase([
        { id: 'old-input', kind: 'user', content: 'Earlier details. '.repeat(8000) },
        { id: 'old-answer', kind: 'assistant', content: 'Earlier work completed.' }
      ])
      if (change === 'initial-model') database.updateThread(thread.id, { modelConfigId: 'second-model' })
      createRun(database, thread.id, 'changing-compression', 'Continue with the next task.')
      const observed = observeModelRequests(), original = compressionModel.createCompressionModel
      vi.spyOn(compressionModel, 'createCompressionModel').mockImplementation((selected, options) => {
        if (change === 'displayName') snapshot.providers[0].models[0].displayName = 'Renamed during preparation'
        return original(selected, options)
      })
      const requests: Array<Record<string, unknown>> = []
      const providerFetch: typeof fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        if (body.messages.length !== 1) return completedResponse('Finished with the current settings.')
        requests.push(body)
        if (requests.length === 1 && change !== 'displayName' && change !== 'initial-model') {
          if (change === 'deleted') snapshot.providers[0].models = []
          else if (change === 'selection') database.updateThread(thread.id, { modelConfigId: 'second-model' })
          else snapshot.providers[0].models[0].parameters = { temperature: 0.7 }
          if (change !== 'in-flight') return Response.json({ error: { message: 'Temporarily unavailable', type: 'server_error' } }, { status: 503 })
        }
        return completedResponse(`Condensed history ${requests.length}`)
      }
      const started: string[] = [], discarded = vi.fn()
      const tracking = createCompressionTracking(database.summaries, 'changing-compression', {
        started: summary => started.push(summary.id), discarded
      })
      const instance = await createConversationInstance(thread, database.resources, snapshot, {
        requestId: 'changing-compression', prepareWorkspace: false, providerFetch, ...tracking
      }, database.execution)
      try {
        const result = await instance.execution.execute('input', { threadId: thread.id, runId: 'changing-compression', signal: new AbortController().signal }, observer())
        const state = database.runs.store.load(thread.id)!
        if (change === 'deleted') {
          expect(result.result.status).toBe('rejected')
          if (result.result.status === 'rejected') expect(String(result.result.reason)).toContain('no longer exists')
          expect(requests).toHaveLength(1)
          expect(observed.requests).toHaveLength(0)
          expect(state.context.summary).toBeUndefined()
        } else {
          if (result.result.status === 'rejected') throw result.result.reason
          expect(result.result.status).toBe('fulfilled')
          expect(observed.requests).toHaveLength(1)
          expect(requests).toHaveLength(change === 'displayName' || change === 'initial-model' ? 1 : 2)
          const mainModel = observed.factory.mock.lastCall![0]
          if (change === 'displayName') expect(mainModel.displayName).toBe('Renamed during preparation')
          else if (change === 'selection' || change === 'initial-model') {
            expect(requests.at(-1)?.model).toBe('second-model')
            expect(mainModel.id).toBe('second-model')
            expect(requests[0].model).toBe(change === 'selection' ? 'preview-model' : 'second-model')
          }
          else {
            expect(requests.at(-1)?.temperature).toBe(0.7)
            expect(mainModel.parameters.temperature).toBe(0.7)
          }
          expect(state.context.summary).toMatchObject({ cutoffIndex: 2 })
          expect(state.messages.some(message => message.id === 'old-input')).toBe(true)
          expect(observed.requests[0].messages.some(message => message.id === 'old-input')).toBe(false)
          if (change === 'in-flight') {
            expect(discarded).toHaveBeenCalledWith(started[0])
            expect(database.runs.store.readMessageRecord(thread.id, state.context.summary!.messageRecordId).value.content).toContain('Condensed history 2')
          }
        }
      } finally { await instance.dispose(); database.close() }
    })
})
