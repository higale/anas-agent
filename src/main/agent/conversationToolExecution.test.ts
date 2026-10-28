import { runtimeToolDefinitions } from '../llm/runtimeTools'
import type { AgentAccessMode } from '@shared/agentTypes'
import type { ShellCommandPlan } from '../shellCommandAuthorization'
import type { SkillScriptInvocation } from '../skillsStore'
import { verifyCurrentShellAuthorization } from './toolAuthorizationRuntime'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { conversationExecution, type ConversationExecutionServices } from '../../runtime/conversationExecution'
import type { ExecutionState, ExecutionToolCall } from '../../runtime/executionState'
import { planningToolSpec } from '../../runtime/planning'
import type { RunObserver } from '../../runtime/runExecution'
import { ToolRunScope, type ToolRunObservation } from '../../runtime/toolEvents'
import type { ToolDefinition } from '../../runtime/toolDefinition'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import { toolResultMessage } from '../../runtime/toolResultMessage'
import { canonicalToolEffectJson } from '../../runtime/toolEffects'
import { ToolInputError } from '../../runtime/errors'
import { FileEditStore } from '../fileEditStore'
import { fileToolDefinitions } from '../llm/fileTools'
import { NativeExecutionStore, nativeExecutionSchema, type NativeExecutionCommit } from './nativeExecutionStore'
import { prepareConversationToolBatch, resolveConversationToolApprovals, type ConversationToolPreparationOptions } from './conversationToolPreparation'
import { createConversationToolExecutor, resolveConversationToolWaits } from './conversationToolExecution'
import { armCurrentAgentToolEffect, canRestartUnpublishedEffectArtifact, currentAgentToolEffectArtifactId, hasCurrentAgentToolEffectScope } from './toolEffectScope'
import type { AgentManagedCallRecord } from './managedCallStore'

const roots: string[] = [], databases: Database.Database[] = []
afterEach(async () => { for (const db of databases.splice(0)) if (db.open) db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const scope = (state: ExecutionState) => ({ threadId: state.threadId, runId: state.runId, expectedRevisionId: state.revisionId })
const observer = (): RunObserver => ({ started: vi.fn(), startModel: vi.fn(() => 'model'), discardModel: vi.fn(), model: vi.fn(), tool: vi.fn(), approval: vi.fn(), committed: vi.fn(async () => {}) })
function call(id: string, name: string, args: Record<string, unknown>): ExecutionToolCall & { args: Record<string, unknown> } {
  return { id, providerCallId: `provider:${id}`, name, args,
    artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, randomUUID()])) as ExecutionToolCall['artifacts'] }
}
function native(definition: ToolDefinition): ToolDefinition<ConversationMessage> {
  return { ...definition, async execute(args, context) {
    return toolResultMessage(await definition.execute(args, context), { name: definition.name, callId: `provider:${context.callId}`, metadata: definition.metadata })
  } }
}
async function fixture(onCommit?: (commit: NativeExecutionCommit) => void) {
  await mkdir(join(process.cwd(), 'tmp'), { recursive: true })
  const root = await realpath(await mkdtemp(join(process.cwd(), 'tmp', 'native-dispatch-'))); roots.push(root)
  const file = join(root, 'execution.sqlite'), db = new Database(file); databases.push(db); db.pragma('foreign_keys=ON'); db.exec(nativeExecutionSchema)
  const store = new NativeExecutionStore(db, onCommit), runId = randomUUID(), fileEditStore = new FileEditStore(join(root, 'edits'))
  const fileTools = fileToolDefinitions({ primaryFolder: root, requestId: runId, maxReadBytes: 10000, fileEditStore, toolNames: ['write_file', 'read_file'] })
  const definitions = fileTools.map(native), options: ConversationToolPreparationOptions = {
    runId, primaryFolder: root, folders: [root], accessMode: () => 'full_access', includeRules: false, fileEditStore, definitions: [...fileTools, planningToolSpec]
  }
  const request = { threadId: 'thread', runId, signal: new AbortController().signal }, operations = new ToolRunScope(), changes = vi.fn()
  const executor = (active = store, tools = definitions) => createConversationToolExecutor({ store: active, definitions: tools,
    preparation: options, operations, planning: true, persistFileChange: changes })
  async function begin(calls: ExecutionToolCall[]) {
    store.start({ threadId: 'thread', runId, context: { modelCalls: 0, todos: [] }, messages: [{ id: 'user', value: { kind: 'user', content: 'Do work' } }] })
    store.acceptModel(scope(store.load('thread')!), { id: 'model', value: { kind: 'assistant', content: '', calls: calls.map(call => ({ id: call.providerCallId, name: call.name, args: call.args })) } }, calls, { modelCalls: 1, todos: [] })
    const state = store.load('thread')!, prepared = await prepareConversationToolBatch(state, options)
    if ('kind' in prepared) throw new Error('Unexpected rule approval')
    store.prepareTools(scope(state), prepared.calls, prepared.approvals, prepared.context)
  }
  return { root, file, db, store, runId, fileEditStore, definitions, options, request, operations, changes, executor, begin }
}

function preparedExecution(h: Awaited<ReturnType<typeof fixture>>, tools: ToolDefinition[], store = h.store) {
  return conversationExecution({ store, enter: async () => {},
    prepareModel: async state => ({ kind: 'model', invoke: async () => ({ message: { id: 'final', value: { kind: 'assistant', content: 'done' } },
      calls: [], context: { ...state.context, modelCalls: state.context.modelCalls + 1 } }) }),
    afterModel: async () => ({ kind: 'complete' }), prepareTools: state => prepareConversationToolBatch(state, h.options),
    executeTool: h.executor(store, tools.map(native)), directions: async () => [], drain: () => h.operations.drain(), retry: { maxRetries: 0 } })
}

function reopen(h: Awaited<ReturnType<typeof fixture>>) {
  h.db.close()
  const database = new Database(h.file); databases.push(database); database.pragma('foreign_keys=ON')
  return new NativeExecutionStore(database)
}
async function dispatchSavedCalls(h: Awaited<ReturnType<typeof fixture>>, store: NativeExecutionStore, tools: ToolDefinition[]) {
  const execute = h.executor(store, tools.map(native))
  for (const call of store.load('thread')!.calls) {
    if (call.result) continue
    const state = store.load('thread')!, result = await execute(call, state, h.request, observer())
    if (result.kind !== 'result') throw new Error('Unexpected recovery wait in approved fixture')
    store.settleCall(scope(store.load('thread')!), call.id, result.message)
  }
  store.finishBatch(scope(store.load('thread')!))
  return store.readHistory('thread')!.messages.map(message => message.value)
}
async function fileApprovalFixture() {
  const h = await fixture(), project = join(h.root, 'project'), outside = join(h.root, 'outside')
  await mkdir(project); await mkdir(outside)
  await writeFile(join(project, 'note.txt'), 'read succeeded'); await writeFile(join(outside, 'note.txt'), 'read succeeded')
  const tools = fileToolDefinitions({ primaryFolder: project, requestId: h.runId, maxReadBytes: 10000,
    fileEditStore: h.fileEditStore, toolNames: ['read_file', 'delete_file'] })
  Object.assign(h.options, { primaryFolder: project, folders: [project], accessMode: () => 'smart_approval', definitions: tools })
  return { ...h, tools, project, target: join(outside, 'note.txt') }
}

async function shellFixture(commands = ['rg -n needle .']) {
  const h = await fixture()
  let mode: AgentAccessMode = 'strict_approval', target = '/project/original', supported = true, skillScript: ShellCommandPlan['skillScript']
  const inspect = vi.fn(async (args: Readonly<Record<string, unknown>>, _invocation?: SkillScriptInvocation): Promise<ShellCommandPlan | undefined> => supported && args.command !== 'unknown command'
    ? { workingDir: '/project', executable: '/shell', paths: [target], ...(skillScript ? { skillScript } : {}) } : undefined)
  const execute = vi.fn(async (args: Record<string, unknown>) => {
    await new Promise<void>(resolve => setImmediate(resolve))
    await verifyCurrentShellAuthorization()
    return { content: args.command }
  })
  const tool: ToolDefinition = { name: 'shell', description: 'Shell fixture', inputSchema: z.object({ command: z.string(), working_dir: z.string().optional() }), execute }
  h.options.definitions = [tool]; h.options.accessMode = () => mode
  h.options.shell = { toolName: 'shell', analyzer: { inspect, requiresApproval: vi.fn() }, accessMode: h.options.accessMode }
  const calls = commands.map((command, index) => call(`shell-${index}`, 'shell', { command, working_dir: '.' }))
  return { ...h, tool, calls, execute, inspect, skill: (value: ShellCommandPlan['skillScript']) => { skillScript = value },
    mode: (value: AgentAccessMode) => { mode = value }, target: (value: string) => { target = value }, supported: (value: boolean) => { supported = value } }
}

describe('native capability dispatch and durable effects', () => {
  it.each([
    { args: JSON.parse('{"command":"Get-Date","timeout":1e400}'), field: '/timeout' },
    { args: { command: 'Get-Date', extra: { values: [Infinity] } }, field: '/extra/values/0' },
    { args: { command: ' \n\t' }, field: 'command' },
    { args: { command: 'Read-Host', pty: { columns: 100, rows: 30 }, keep_processes: true }, field: 'keep_processes' }
  ])('returns invalid Shell $field before inspection, approval or effects, then accepts correction', async ({ args, field }) => {
    const h = await fixture(), execute = vi.fn(async () => { await verifyCurrentShellAuthorization(); return 'Executed' })
    const tools = (await runtimeToolDefinitions({ enabled: true, primaryFolder: h.root, memory: false, network: false,
      shell: true, mcp: false, commandShell: { executable: 'pwsh.exe', name: 'PowerShell', family: 'powershell' },
      backgroundTools: true, threadId: 'thread', shellRunner: execute,
      managedCalls: { read: vi.fn(), readOutput: vi.fn(), readResult: vi.fn(), wait: vi.fn(), cancel: vi.fn(), start: vi.fn(), writeTerminal: vi.fn() }
    })).filter(tool => tool.name === 'pwsh')
    const inspect = vi.fn(async (_args: Readonly<Record<string, unknown>>) => undefined), effects = vi.spyOn(h.store, 'prepareEffect')
    h.options.definitions = tools; h.options.accessMode = () => 'strict_approval'
    h.options.shell = { toolName: 'pwsh', analyzer: { inspect, requiresApproval: vi.fn() }, accessMode: h.options.accessMode }
    await h.begin([call('invalid', 'pwsh', args)])
    const invalid = h.store.load('thread')!
    expect(invalid.response!.value.calls![0].args).toEqual(args)
    expect(invalid.calls[0].result?.value).toMatchObject({ resultStatus: 'error', content: expect.stringContaining(field) })
    expect(invalid.approvals).toHaveLength(0); expect(inspect).not.toHaveBeenCalled(); expect(effects).not.toHaveBeenCalled()
    h.store.finishBatch(scope(invalid))
    const corrected = call('corrected', 'pwsh', { command: 'Get-Date' }), ready = h.store.load('thread')!
    h.store.acceptModel(scope(ready), { id: 'corrected-model', value: { kind: 'assistant', content: '', calls: [{ id: corrected.providerCallId, name: corrected.name, args: corrected.args }] } }, [corrected], { ...ready.context, modelCalls: 2 })
    const state = h.store.load('thread')!, prepared = await prepareConversationToolBatch(state, h.options)
    if ('kind' in prepared) throw new Error('Unexpected rule approval')
    h.store.prepareTools(scope(state), prepared.calls, prepared.approvals, prepared.context)
    expect(inspect.mock.calls.map(([input]) => input)).toEqual([{ command: 'Get-Date' }])
    expect(effects).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled()
    const store = reopen(h), saved = store.load('thread')!, approval = saved.approvals[0], resumedEffects = vi.spyOn(store, 'prepareEffect')
    expect(approval.request.actionRequests).toMatchObject([{ name: 'pwsh', args: { command: 'Get-Date' } }])
    resolveConversationToolApprovals(store, scope(saved), [{ id: approval.id, generation: approval.generation, response: { decisions: [{ type: 'approve' }] } }])
    const messages = await dispatchSavedCalls(h, store, tools)
    expect(messages.filter(message => message.kind === 'tool')).toMatchObject([
      { resultFor: 'provider:invalid', resultStatus: 'error' }, { resultFor: 'provider:corrected', content: 'Executed' }
    ])
    expect(resumedEffects).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledOnce()
  })


  it.each(['revoke', 'skillId', 'root', 'script', 'executor'] as const)('rechecks changed Skill exemption %s at delayed dispatch after reopening', async change => {
    const h = await shellFixture(['python scripts/query.py --month 2026-09'])
    const binding = { skillId: 'user:query', root: '/skills/query', script: '/skills/query/scripts/query.py', executor: '/python' }
    h.skill(binding); await h.begin(h.calls)
    const store = reopen(h)
    expect(store.load('thread')!.calls[0].authorization?.shell).toMatchObject({ humanApproved: false, plan: { skillScript: binding } })
    if (change === 'revoke') h.supported(false); else h.skill({ ...binding, [change]: '/changed' })
    await expect(dispatchSavedCalls(h, store, [h.tool])).rejects.toThrow('targets changed')
  })

  it('reopens original Shell commands and separate read bindings before delayed runner verification', async () => {
    const h = await shellFixture(['# original comment\n rg -n needle .  ', 'Get-Content notes.txt | Select-Object -First 1'])
    const original = structuredClone(h.calls)
    await h.begin(h.calls); expect(h.execute).not.toHaveBeenCalled()
    const store = reopen(h), state = store.load('thread')!
    expect(state.response!.value.calls).toEqual(original.map(call => ({ id: call.providerCallId, name: call.name, args: call.args })))
    expect(state.calls.map(call => call.authorization?.shell)).toMatchObject([
      { humanApproved: false, plan: { paths: ['/project/original'] } }, { humanApproved: false, plan: { paths: ['/project/original'] } }
    ])
    const messages = await dispatchSavedCalls(h, store, [h.tool])
    expect(messages.filter(message => message.kind === 'tool').map(message => message.content).sort()).toEqual(original.map(call => call.args.command).sort())
    expect(h.execute.mock.calls.map(([args]) => args)).toEqual(original.map(call => call.args))
  })

  it.each(['target', 'unsupported', 'run'] as const)('rejects a stale automatic Shell authorization after %s changes', async change => {
    const h = await shellFixture(); await h.begin(h.calls)
    const store = reopen(h)
    if (change === 'target') h.target('/project/other')
    if (change === 'unsupported') h.supported(false)
    if (change === 'run') h.request.runId = randomUUID()
    await expect(dispatchSavedCalls(h, store, [h.tool])).rejects.toThrow(/targets changed|belongs to this run/)
  })

  it.each(['approve', 'reject'] as const)('retains unknown Shell commands under a durable %s decision', async decision => {
    const h = await shellFixture(['rg --pre custom-helper needle . > output.txt']); h.supported(false)
    await h.begin(h.calls)
    const store = reopen(h), state = store.load('thread')!, approval = state.approvals[0]
    expect(approval.request.actionRequests).toMatchObject([{ args: h.calls[0].args }])
    resolveConversationToolApprovals(store, scope(state), [{ id: approval.id, generation: approval.generation, response: { decisions: [{ type: decision }] } }])
    const messages = await dispatchSavedCalls(h, store, [h.tool])
    expect(h.execute).toHaveBeenCalledTimes(decision === 'approve' ? 1 : 0)
    if (decision === 'approve') expect(messages.filter(message => message.kind === 'tool').at(-1)?.content).toBe(h.calls[0].args.command)
  })

  it('does not turn full access into a human grant after reopening and tightening access', async () => {
    const h = await shellFixture(['unknown command']); h.mode('full_access'); await h.begin(h.calls)
    const store = reopen(h); h.mode('strict_approval')
    expect(store.load('thread')!.calls[0].authorization?.shell?.humanApproved).toBe(false)
    await expect(dispatchSavedCalls(h, store, [h.tool])).rejects.toThrow('access mode changed')
  })

  it('executes unchanged full-access commands without read analysis', async () => {
    const h = await shellFixture(['unknown command']); h.mode('full_access'); await h.begin(h.calls)
    const messages = await dispatchSavedCalls(h, h.store, [h.tool])
    expect(h.inspect).not.toHaveBeenCalled()
    expect(messages.filter(message => message.kind === 'tool').at(-1)?.content).toBe('unknown command')
  })

  it('does not accept the former command comment as Shell authorization', async () => {
    const h = await shellFixture(['# Anas verified read\nunknown command']); h.supported(false); await h.begin(h.calls)
    expect(h.store.load('thread')!.approvals).toHaveLength(1); expect(h.execute).not.toHaveBeenCalled()
  })

  it('keeps a human Shell grant separate from automatic sibling authorization across reopening', async () => {
    const h = await shellFixture(['rg -n needle .', 'unknown command']); await h.begin(h.calls)
    const store = reopen(h), state = store.load('thread')!, approval = state.approvals[0]
    expect(approval.request.actionRequests).toMatchObject([{ args: h.calls[1].args }])
    resolveConversationToolApprovals(store, scope(state), [{ id: approval.id, generation: approval.generation, response: { decisions: [{ type: 'approve' }] } }])
    expect(store.load('thread')!.calls.map(call => call.authorization?.shell)).toMatchObject([
      { requiresApproval: false, humanApproved: false }, { requiresApproval: true, humanApproved: true }
    ])
    const messages = await dispatchSavedCalls(h, store, [h.tool])
    expect(messages.filter(message => message.kind === 'tool').map(message => message.content).sort()).toEqual(h.calls.map(call => call.args.command).sort())
  })


  it('rejects an invalid delete while independently executing a valid read', async () => {
    const h = await fileApprovalFixture()
    h.options.accessMode = () => 'full_access'
    await h.begin([call('invalid', 'delete_file', { path: '' }), call('read', 'read_file', { path: 'note.txt' })])
    const messages = await dispatchSavedCalls(h, h.store, h.tools)
    expect(messages.find(message => message.resultFor === 'provider:invalid')?.resultStatus).toBe('error')
    expect(String(messages.find(message => message.resultFor === 'provider:read')?.content)).toContain('read succeeded')
    expect(await readFile(join(h.project, 'note.txt'), 'utf8')).toBe('read succeeded')
  })

  it.each(['approve', 'reject'] as const)('retains external delete %s after database reopening', async decision => {
    const h = await fileApprovalFixture()
    await h.begin([call('invalid', 'read_file', { path: '' }), call('external', 'delete_file', { path: h.target })])
    const waiting = h.store.load('thread')!
    expect(waiting.approvals).toHaveLength(1)
    expect(waiting.approvals[0].request.actionRequests).toMatchObject([{ name: 'delete_file', args: { path: h.target } }])
    expect(await readFile(h.target, 'utf8')).toBe('read succeeded')
    const store = reopen(h), state = store.load('thread')!, approval = state.approvals[0]
    expect(state.calls).toEqual(waiting.calls)
    resolveConversationToolApprovals(store, scope(state), [{ id: approval.id, generation: approval.generation, response: { decisions: [{ type: decision }] } }])
    const messages = await dispatchSavedCalls(h, store, h.tools)
    expect(messages.filter(message => message.resultFor === 'provider:invalid')).toHaveLength(1)
    expect(messages.find(message => message.resultFor === 'provider:invalid')?.resultStatus).toBe('error')
    if (decision === 'approve') await expect(readFile(h.target)).rejects.toMatchObject({ code: 'ENOENT' })
    else expect(await readFile(h.target, 'utf8')).toBe('read succeeded')
  })

  it('retains one input error and rejects automatic siblings when another action is rejected', async () => {
    const h = await fileApprovalFixture(), reads = vi.spyOn(h.tools.find(tool => tool.name === 'read_file')!, 'execute')
    await h.begin([call('invalid', 'read_file', { path: '' }), call('automatic', 'read_file', { path: 'note.txt' }),
      call('review', 'delete_file', { path: h.target })])
    const state = h.store.load('thread')!, approval = state.approvals[0]
    expect(approval.request.actionRequests).toMatchObject([{ name: 'delete_file' }])
    resolveConversationToolApprovals(h.store, scope(state), [{ id: approval.id, generation: approval.generation, response: { decisions: [{ type: 'reject', message: 'Keep it' }] } }])
    const messages = await dispatchSavedCalls(h, h.store, h.tools), outputs = messages.filter(message => message.kind === 'tool')
    expect(outputs).toHaveLength(3)
    expect(new Set(outputs.map(message => message.resultFor)).size).toBe(3)
    expect(outputs.find(message => message.resultFor === 'provider:invalid')?.content).toMatch(/path/i)
    expect(outputs.find(message => message.resultFor === 'provider:automatic')?.content).toContain('NOT EXECUTED')
    expect(outputs.find(message => message.resultFor === 'provider:review')?.content).toContain('Keep it')
    expect(outputs.every(message => message.resultStatus === 'error')).toBe(true)
    expect(messages.find(message => message.kind === 'assistant')?.calls?.map(call => call.id)).toEqual(['provider:invalid', 'provider:automatic', 'provider:review'])
    expect(reads).not.toHaveBeenCalled()
    expect(await readFile(h.target, 'utf8')).toBe('read succeeded')
  })

  it.each(['automatic', 'approve', 'reject'] as const)('preserves original Shell arguments and %s decision across recreation', async decision => {
    const h = await fixture(), execute = vi.fn(async (_args: unknown) => ({ content: 'done' }))
    const tool: ToolDefinition = { name: 'pwsh', description: 'Shell', inputSchema: z.object({ command: z.string() }), execute }
    h.options.definitions = [tool]
    h.options.accessMode = () => decision === 'automatic' ? 'full_access' : 'smart_approval'
    const inspect = vi.fn(async () => undefined)
    h.options.shell = { toolName: 'pwsh', analyzer: { inspect, requiresApproval: vi.fn(async () => true) }, accessMode: h.options.accessMode }
    await h.begin([call('shell', 'pwsh', { command: 'original' })])
    expect(execute).not.toHaveBeenCalled()
    const store = reopen(h), state = store.load('thread')!
    expect(state.calls[0].args).toEqual({ command: 'original' })
    expect(state.response!.value.calls![0].args).toEqual({ command: 'original' })
    if (decision === 'automatic') expect(state.approvals).toHaveLength(0)
    else {
      expect(state.approvals).toHaveLength(1)
      const approval = state.approvals[0]
      resolveConversationToolApprovals(store, scope(state), [{ id: approval.id, generation: approval.generation,
        response: { decisions: [{ type: decision, ...(decision === 'reject' ? { message: 'cancelled' } : {}) }] } }])
    }
    await dispatchSavedCalls(h, store, [tool])
    expect(execute).toHaveBeenCalledTimes(decision === 'reject' ? 0 : 1)
    if (decision !== 'reject') expect(execute.mock.calls[0][0]).toEqual({ command: 'original' })
  })

  it('retains the bound file path independently of Shell commands after recreation', async () => {
    const h = await fileApprovalFixture()
    h.options.accessMode = () => 'strict_approval'
    await h.begin([call('read', 'read_file', { path: 'note.txt' })])
    const store = reopen(h), state = store.load('thread')!
    expect(state.calls[0].args).toEqual({ path: join(h.project, 'note.txt') })
    expect(state.response!.value.calls![0].args).toEqual({ path: join(h.project, 'note.txt') })
    const messages = await dispatchSavedCalls(h, store, h.tools)
    expect(String(messages.find(message => message.resultFor === 'provider:read')?.content)).toContain('read succeeded')
  })

  it('publishes both parallel starts, observes completion order and persists results in call order', async () => {
    const h = await fixture(), events: ToolRunObservation[] = []
    let first!: () => void, second!: () => void
    const waits = [new Promise<void>(resolve => { first = resolve }), new Promise<void>(resolve => { second = resolve })]
    const tools: ToolDefinition[] = ['one', 'two'].map((name, index) => ({ name, description: '', inputSchema: z.object({}),
      execute: async () => { await waits[index]; return { content: name + ' result' } } }))
    h.options.definitions = tools
    await h.begin([call('one', 'one', {}), call('two', 'two', {})])
    const observed = observer(); observed.tool = event => { events.push(event) }
    let finished = false
    const task = preparedExecution(h, tools).execute('continue', h.request, observed).finally(() => { finished = true })
    try {
      await vi.waitFor(() => expect(events.map(event => event.kind)).toEqual(['started', 'started']))
      second()
      await vi.waitFor(() => expect(events.filter(event => event.kind === 'settled').map(event => event.call.id)).toEqual(['two']))
      expect(finished).toBe(false)
      first()
      expect((await task).result.status).toBe('fulfilled')
      expect(events.filter(event => event.kind === 'settled').map(event => event.call.id)).toEqual(['two', 'one'])
      expect(h.store.load('thread')!.messages.filter(record => record.value.kind === 'tool').map(record => ({
        call: record.value.resultFor, content: record.value.content
      }))).toEqual([{ call: 'provider:one', content: 'one result' }, { call: 'provider:two', content: 'two result' }])
    } finally { first(); second(); await task }
  })

  it.each([false, true])('retains dispatch observations and artifacts when display fails=%s', async displayFails => {
    const h = await fixture(), failure = new Error('display failed'), events: ToolRunObservation[] = []
    const transform = vi.fn(async (value: string) => value.toUpperCase())
    const execute = vi.fn(input => ({ content: input, artifact: { bytes: new Uint8Array([1, 2]) } }))
    const tool: ToolDefinition = { name: 'inspect', description: '', inputSchema: z.object({ label: z.string().transform(transform), count: z.number().default(0) }), execute }
    h.options.definitions = [tool]
    await h.begin([call('call', tool.name, { label: 'raw', extra: true })])
    const observed = observer()
    observed.tool = event => { events.push(event); if (displayFails) throw failure }
    const result = await preparedExecution(h, [tool]).execute('continue', h.request, observed)
    expect(result.result.status).toBe('fulfilled')
    expect(result.observationErrors).toEqual(displayFails ? [failure] : [])
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0][0]).toEqual({ label: 'RAW', count: 0 })
    // Preflight checks the raw schema; dispatch parses that same raw input.
    // A transformation must never be applied to an already transformed value.
    expect(transform.mock.calls.map(call => call[0])).toEqual(['raw', 'raw'])
    expect(events.map(event => event.kind)).toEqual(['started', 'settled'])
    expect(events[0].call.args).toEqual({ label: 'raw', extra: true })
    const settled = events[1]
    if (settled.kind !== 'settled') throw new Error('Expected settled observation')
    expect(settled.succeeded).toBe(true)
    expect(JSON.parse(String(settled.output))).toEqual({ label: 'RAW', count: 0 })
    const state = h.store.load('thread')!
    expect(state.phase).toBe('completed')
    expect(state.messages.find(message => message.value.kind === 'tool')!.value).toMatchObject({ resultFor: 'provider:call', artifact: { bytes: new Uint8Array([1, 2]) } })
  })

  it('waits for an entered sibling and records its final observation after another capability fails', async () => {
    const h = await fixture(), events: ToolRunObservation[] = []
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve }), cleanup = new Promise<void>(resolve => { release = resolve })
    const tools: ToolDefinition[] = [
      { name: 'first', description: '', inputSchema: z.object({}), execute: async () => { await ready; throw new Error('first failed') } },
      { name: 'second', description: '', inputSchema: z.object({}), execute: async () => { entered(); await cleanup; return { content: 'confirmed sibling' } } }
    ]
    h.options.definitions = tools
    await h.begin([call('one', 'first', {}), call('two', 'second', {})])
    const observed = observer(); observed.tool = event => { events.push(event) }
    let finished = false
    const task = preparedExecution(h, tools).execute('continue', h.request, observed).finally(() => { finished = true })
    try {
      await ready
      await vi.waitFor(() => expect(events.some(event => event.kind === 'settled' && event.call.id === 'one')).toBe(true))
      expect(finished).toBe(false)
    } finally { release() }
    expect((await task).result.status).toBe('rejected')
    expect(events.filter(event => event.kind === 'settled').map(event => event.call.id)).toEqual(['one', 'two'])
    const state = h.store.load('thread')!
    expect(state.phase).toBe('failed')
    expect(state.messages.find(message => message.value.resultFor === 'provider:two')?.value.content).toBe('confirmed sibling')
    const count = events.length
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(events).toHaveLength(count)
  })

  it('runs the real file transaction and restores its saved result after reopen without overwriting later content', async () => {
    const h = await fixture(), path = join(h.root, 'output.txt'), tool = call('write', 'write_file', { path, content: 'first content' })
    await h.begin([tool])
    const observed = observer(), state = h.store.load('thread')!, result = await h.executor()(state.calls[0], state, h.request, observed)
    if (result.kind !== 'result') throw new Error('Unexpected recovery')
    expect(await readFile(path, 'utf8')).toBe('first content')
    expect(JSON.parse(String(result.message.value.content))).toMatchObject({ ok: true, operationId: tool.artifacts.file_edit, recoveryRequestId: h.runId })
    expect(h.store.loadEffect({ ...h.request, callId: tool.id })!.state).toBe('result')
    expect(h.changes).toHaveBeenCalled()
    expect(observed.tool).toHaveBeenCalledWith(expect.objectContaining({ kind: 'settled',
      call: expect.objectContaining({ id: tool.id }), output: result.message.value.content }))
    expect(h.store.load('thread')!.calls[0].result).toBeUndefined()
    await writeFile(path, 'later user edit')
    h.db.close()
    const db = new Database(h.file); databases.push(db); db.pragma('foreign_keys=ON')
    const store = new NativeExecutionStore(db), reopened = store.load('thread')!
    const restored = await h.executor(store, [])(reopened.calls[0], reopened, h.request, observer())
    if (restored.kind !== 'result') throw new Error('Expected stored result')
    expect(restored.message.value).toEqual(result.message.value)
    expect(await readFile(path, 'utf8')).toBe('later user edit')
    store.settleCall(scope(reopened), tool.id, restored.message)
    store.finishBatch(scope(store.load('thread')!))
    expect(store.load('thread')!.messages.at(-1)!.value).toEqual(result.message.value)
  })

  it('keeps repeated recovery decisions separate and rolls rejection and intent consumption back together', async () => {
    let fail = false
    const h = await fixture(() => { if (fail) throw new Error('commit failed') }), invoked = vi.fn(() => {
      armCurrentAgentToolEffect({ kind: 'fixture', target: { operation: 'remote' } }); throw new Error('response lost')
    })
    const definition: ToolDefinition = { name: 'mcp_mutation', description: '', inputSchema: z.object({}), execute: invoked }
    h.options.definitions = [definition]
    await h.begin([call('remote', definition.name, {})])
    const execute = h.executor(h.store, [native(definition)])
    async function run() {
      const state = h.store.load('thread')!, result = await execute(state.calls[0], state, h.request, observer())
      if (result.kind !== 'wait') throw new Error('Expected recovery confirmation')
      h.store.wait(scope(h.store.load('thread')!), [result.approval])
      return result.approval
    }
    const first = await run()
    resolveConversationToolWaits(h.store, scope(h.store.load('thread')!), [{ id: first.id, generation: first.generation, response: { decisions: [{ type: 'approve' }] } }])
    const second = await run(), waiting = h.store.load('thread')!
    expect(invoked).toHaveBeenCalledTimes(2)
    expect(() => resolveConversationToolWaits(h.store, scope(waiting), [{ id: first.id, generation: first.generation, response: { decisions: [{ type: 'approve' }] } }])).toThrow('generation changed')
    const answers = [{ id: second.id, generation: second.generation, response: { decisions: [{ type: 'reject', message: 'Leave the remote state' }] } }]
    h.db.exec('CREATE TABLE intent (consumed INTEGER); INSERT INTO intent VALUES (0)')
    fail = true
    expect(() => resolveConversationToolWaits(h.store, scope(waiting), answers, () => { h.db.exec('UPDATE intent SET consumed=1') })).toThrow('commit failed')
    expect(h.db.prepare('SELECT * FROM intent').get()).toEqual({ consumed: 0 })
    expect(h.store.loadEffect({ ...h.request, callId: 'remote' })!.state).toBe('intent')
    fail = false
    resolveConversationToolWaits(h.store, scope(waiting), answers)
    const after = h.store.load('thread')!
    expect(after.calls[0].result!.value.content).toContain('may already have happened')
    expect(after.calls[0].result!.value.content).toContain('Leave the remote state')
    expect(h.store.loadEffect({ ...h.request, callId: 'remote' })!.confirmationCount).toBe(2)
    expect((await execute(after.calls[0], after, h.request, observer())).kind).toBe('result')
    expect(invoked).toHaveBeenCalledTimes(2)
  })

  it('lets an authorized effectful sibling finish after another call has persisted its recovery wait', async () => {
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    const h = await fixture(commit => { if (commit.phase === 'waiting') release() })
    const blocked = vi.fn(() => { throw new Error('Must not replay uncertain effect') })
    const completed = vi.fn(async () => {
      await waiting
      expect(h.store.load('thread')!.phase).toBe('waiting')
      armCurrentAgentToolEffect({ kind: 'fixture', target: { operation: 'sibling' } })
      return { content: 'sibling completed' }
    })
    const tools: ToolDefinition[] = [{ name: 'mcp_blocked', description: '', inputSchema: z.object({}), execute: blocked },
      { name: 'mcp_sibling', description: '', inputSchema: z.object({}), execute: completed }]
    h.options.definitions = tools
    await h.begin([call('blocked', tools[0].name, {}), call('sibling', tools[1].name, {})])
    h.store.prepareEffect({ ...h.request, callId: 'blocked' }, 'confirm')
    h.store.armEffect({ ...h.request, callId: 'blocked' }, { kind: 'fixture', target: { operation: 'prior' } })
    const services: ConversationExecutionServices = { store: h.store, enter: async () => {},
      prepareModel: async state => ({ kind: 'model', invoke: async () => ({ message: { id: 'final', value: { kind: 'assistant', content: 'done' } }, calls: [], context: state.context }) }),
      afterModel: async () => ({ kind: 'complete' }), prepareTools: async state => prepareConversationToolBatch(state, h.options),
      executeTool: h.executor(h.store, tools.map(native)), directions: async () => [], drain: () => h.operations.drain() }
    const execution = conversationExecution(services), result = await execution.execute('continue', h.request, observer())
    expect(result.result.status).toBe('fulfilled')
    expect(result.interrupted).toBe(true)
    const paused = h.store.load('thread')!, approval = paused.approvals[0]
    expect(paused.calls[1].result!.value.content).toBe('sibling completed')
    expect(blocked).not.toHaveBeenCalled()
    resolveConversationToolWaits(h.store, scope(paused), [{ id: approval.id, generation: approval.generation, response: { decisions: [{ type: 'reject' }] } }])
    expect((await execution.execute('continue', h.request, observer())).result.status).toBe('fulfilled')
    expect(h.store.load('thread')!.phase).toBe('completed')
    expect(completed).toHaveBeenCalledOnce()
  })

  it('commits only trusted planning updates and distinguishes input errors from operational failures', async () => {
    const h = await fixture(), todos = [{ content: 'Finish', status: 'in_progress' as const }]
    const invalid: ToolDefinition = { name: 'request_user_input', description: '', inputSchema: z.object({}), execute: () => { throw new ToolInputError('bad range') } }
    const failed: ToolDefinition = { name: 'sleep', description: '', inputSchema: z.object({}), execute: () => { throw new Error('service failed') } }
    h.options.definitions = [planningToolSpec, invalid, failed]
    await h.begin([call('plan', 'write_todos', { todos }), call('invalid', invalid.name, {}), call('failed', 'sleep', {})])
    const state = h.store.load('thread')!, execute = h.executor(h.store, [native(invalid), native(failed)])
    const plan = await execute(state.calls[0], state, h.request, observer())
    if (plan.kind !== 'result') throw new Error('Expected plan')
    expect(plan.update).toEqual({ todos })
    h.store.settleCall(scope(state), 'plan', plan.message, plan.update)
    expect(h.store.load('thread')!.context.todos).toEqual(todos)
    const input = await execute(state.calls[1], state, h.request, observer())
    if (input.kind !== 'result') throw new Error('Expected input error')
    expect(input.message.value.resultStatus).toBe('error')
    expect(input.message.value.content).toContain('Correct the arguments')
    expect(input.message.value.content).toContain('bad range')
    await expect(execute(state.calls[2], state, h.request, observer())).rejects.toThrow('service failed')
  })

  it.each(['execution', 'stored-data', 'wrapped-input', 'invalid-effect', 'cancelled'] as const)('preserves %s failure without saving a model correction result', async kind => {
    const h = await fixture(), controller = new AbortController()
    const stopped = new Error('User stopped the run')
    const failure = kind === 'stored-data' ? z.object({ checkpoint: z.string() }).safeParse({}).error!
      : kind === 'wrapped-input' ? new Error('Execution failed', { cause: new ToolInputError('Hidden cause') })
        : new Error('Execution acknowledgement lost')
    const execute = vi.fn(() => {
      if (kind === 'cancelled') { controller.abort(stopped); throw new ToolInputError('Unavailable target') }
      if (kind === 'invalid-effect') { canonicalToolEffectJson({ result: Infinity }); return { content: '' } }
      throw failure
    })
    const definition: ToolDefinition = { name: 'sleep', description: '', inputSchema: z.object({}), execute }
    h.options.definitions = [definition]; h.request.signal = controller.signal
    await h.begin([call('failed', definition.name, {})])
    const state = h.store.load('thread')!, invoke = h.executor(h.store, [native(definition)])
    if (kind === 'invalid-effect') await expect(invoke(state.calls[0], state, h.request, observer())).rejects.toThrow('finite numbers')
    else await expect(invoke(state.calls[0], state, h.request, observer())).rejects.toBe(kind === 'cancelled' ? stopped : failure)
    expect(execute).toHaveBeenCalledOnce()
    expect(h.store.load('thread')).toEqual(state)
    expect(h.store.load('thread')!.calls[0].result).toBeUndefined()
    expect(h.store.load('thread')!.context.modelCalls).toBe(1)
  })

  it.each([false, true])('resumes parallel effect approvals independently after reopen, with metadata drift=%s', async drift => {
    const h = await fixture(), counts = [0, 0], requested = ['left', 'right'].map((name, index) => call(String(index), `mcp_${name}`, {}))
    const tools: ToolDefinition[] = ['left', 'right'].map((name, index) => ({ name: `mcp_${name}`, description: '', inputSchema: z.object({}), execute: () => {
      for (const purpose of toolEffectArtifactPurposes) expect(currentAgentToolEffectArtifactId(purpose)).toBe(requested[index].artifacts[purpose])
      expect(canRestartUnpublishedEffectArtifact(h.runId, requested[index].artifacts.file_edit, 'file_edit')).toBe(counts[index] === 0)
      expect(canRestartUnpublishedEffectArtifact('foreign', requested[index].artifacts.file_edit, 'file_edit')).toBe(false)
      expect(canRestartUnpublishedEffectArtifact(h.runId, requested[index].artifacts.file_edit, 'file_restore')).toBe(false)
      armCurrentAgentToolEffect({ kind: 'mcp_call', target: { name } })
      expect(canRestartUnpublishedEffectArtifact(h.runId, requested[index].artifacts.file_edit, 'file_edit')).toBe(false)
      if (++counts[index] === 1) throw new Error('Lost acknowledgement')
      return { content: `${name} completed` }
    } }))
    expect(new Set(requested.flatMap(call => Object.values(call.artifacts))).size).toBe(toolEffectArtifactPurposes.length * 2)
    h.options.definitions = tools; await h.begin(requested)
    expect((await preparedExecution(h, tools).execute('continue', h.request, observer())).result.status).toBe('fulfilled')
    expect(counts).toEqual([1, 1])
    const pending = h.store.load('thread')!.approvals
    expect(pending).toHaveLength(2)
    if (drift) for (const tool of tools) tool.metadata = { annotations: { readOnlyHint: true } }
    const store = reopen(h), execution = preparedExecution(h, tools, store)
    for (const [index, approval] of pending.entries()) {
      resolveConversationToolWaits(store, scope(store.load('thread')!), [{ id: approval.id, generation: approval.generation, response: { decisions: [{ type: 'approve' }] } }])
      expect((await execution.execute('continue', h.request, observer())).result.status).toBe('fulfilled')
      const state = store.load('thread')!
      if (index === 0) {
        expect(counts.reduce((sum, count) => sum + count, 0)).toBe(3)
        expect(state.phase).toBe('waiting'); expect(state.approvals).toEqual([pending[1]])
        expect(state.calls.filter(call => call.result)).toHaveLength(1)
      } else { expect(counts).toEqual([2, 2]); expect(state.phase).toBe('completed') }
    }
    expect(store.readHistory('thread')!.messages.filter(message => message.value.kind === 'tool').map(message => message.value.content)).toEqual(['left completed', 'right completed'])
    expect(currentAgentToolEffectArtifactId('managed-call')).toBeUndefined()
  })

  it.each([0, 1])('keeps parallel effect ownership while dispatch preflight %s waits asynchronously', async delayed => {
    const h = await fixture(), counts = [0, 0]; let dispatching = false, release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const requested = [call('left', 'mcp_left', {}), call('right', 'mcp_right', {})]
    const tools: ToolDefinition[] = requested.map((call, index) => ({ name: call.name, description: '',
      inputSchema: z.object({}).superRefine(async () => { if (dispatching && index === delayed) await gate }), execute: () => {
        expect(currentAgentToolEffectArtifactId('managed-call')).toBe(call.artifacts['managed-call'])
        armCurrentAgentToolEffect({ kind: 'mcp_call', target: { name: call.name } }); counts[index]++
        return { content: call.name }
      } }))
    h.options.definitions = tools; await h.begin(requested); dispatching = true
    const pending = preparedExecution(h, tools).execute('continue', h.request, observer())
    try { await vi.waitFor(() => expect(counts[1 - delayed]).toBe(1)); expect(counts[delayed]).toBe(0) }
    finally { release(); await pending }
    expect((await pending).result.status).toBe('fulfilled'); expect(counts).toEqual([1, 1])
    expect(h.store.readHistory('thread')!.messages.filter(message => message.value.kind === 'tool').map(message => message.value.resultFor)).toEqual(['provider:left', 'provider:right'])
    for (const call of requested) expect(h.store.loadEffect({ ...h.request, callId: call.id })).toMatchObject({ state: 'result', effectAttempt: 1, artifacts: call.artifacts })
  })

  it.each([
    { recoveryMode: 'confirm' as const, drift: false }, { recoveryMode: 'confirm' as const, drift: true },
    { recoveryMode: 'idempotent' as const, drift: false }, { recoveryMode: 'idempotent' as const, drift: true }
  ])('retries only the exact persisted $recoveryMode target when drift=$drift', async ({ recoveryMode, drift }) => {
    const h = await fixture(); let attempts = 0, target = 'original'
    const tool: ToolDefinition = { name: 'mcp_write', description: '', inputSchema: z.object({}), execute: () => {
      armCurrentAgentToolEffect({ kind: 'remote_write', target: { target }, recoveryMode,
        ...(recoveryMode === 'idempotent' ? { idempotencyFingerprint: 'a'.repeat(64) } : {}) })
      if (++attempts === 1) { if (drift) target = 'changed'; throw new Error('Lost acknowledgement') }
      return { content: 'Completed exact retry' }
    } }
    h.options.definitions = [tool]; await h.begin([call('retry', tool.name, {})])
    let execution = preparedExecution(h, [tool]), store = h.store
    let result = await execution.execute('continue', h.request, observer())
    if (recoveryMode === 'confirm') {
      const approval = store.load('thread')!.approvals[0]
      expect(attempts).toBe(1); expect(approval.kind).toBe('effect_recovery')
      store = reopen(h); execution = preparedExecution(h, [tool], store)
      resolveConversationToolWaits(store, scope(store.load('thread')!), [{ id: approval.id, generation: approval.generation, response: { decisions: [{ type: 'approve' }] } }])
      result = await execution.execute('continue', h.request, observer())
    }
    expect(attempts).toBe(drift ? 1 : 2)
    const effect = store.loadEffect({ ...h.request, callId: 'retry' })!
    expect(effect.targetJson).toBe('{"target":"original"}')
    if (drift) {
      expect(result.result.status).toBe('rejected')
      if (result.result.status !== 'rejected') throw new Error('Expected target drift failure')
      expect(String(result.result.reason)).toContain('different effect boundary')
      expect(effect.effectAttempt).toBe(1)
    } else {
      expect(result.result.status).toBe('fulfilled'); expect(store.load('thread')!.phase).toBe('completed')
      expect(effect).toMatchObject({ state: 'result', effectAttempt: 2 })
    }
  })

  it.each(['intent read', 'result read', 'prepared read', 'prepared confirm', 'prepared idempotent'] as const)('honors persisted effect progress after metadata changes: %s', async scenario => {
    const h = await fixture(), requested = call('drift', 'mcp_mutation', {}), boundary = { kind: 'mcp_call', target: { resource: 'A' } }
    const invoked = vi.fn(() => { expect(hasCurrentAgentToolEffectScope()).toBe(true); armCurrentAgentToolEffect(boundary); return { content: 'Executed once' } })
    const definition: ToolDefinition = { name: requested.name, description: '', inputSchema: z.object({}), execute: invoked }
    h.options.definitions = [definition]; await h.begin([requested])
    const key = { ...h.request, callId: requested.id }
    h.store.prepareEffect(key, scenario === 'prepared confirm' ? 'idempotent' : 'confirm')
    if (!scenario.startsWith('prepared')) h.store.armEffect(key, boundary)
    const rejected = { id: 'rejection', value: { kind: 'tool' as const, resultFor: requested.providerCallId, content: 'Saved rejection', resultStatus: 'error' as const } }
    if (scenario === 'result read') h.store.saveEffectResult(key, rejected, { kind: 'rejected', expectedConfirmationCount: 0 })
    definition.metadata = { annotations: scenario.endsWith('read') ? { readOnlyHint: true } : scenario.endsWith('idempotent') ? { idempotentHint: true } : {} }
    const store = reopen(h), state = store.load('thread')!, execute = h.executor(store, [native(definition)])
    const result = await execute(state.calls[0], state, h.request, observer())
    if (scenario === 'intent read') {
      expect(result.kind).toBe('wait'); expect(invoked).not.toHaveBeenCalled()
      if (result.kind !== 'wait') throw new Error('Expected uncertain effect approval')
      expect(result.approval.request).toMatchObject({ actionRequests: [{ name: requested.name, anasRecovery: { ordinal: 1, state: 'uncertain' } }] })
      expect(store.loadEffect(key)).toMatchObject({ state: 'intent', effectAttempt: 1, recoveryMode: 'confirm' })
    } else {
      if (result.kind !== 'result') throw new Error('Expected native result')
      if (scenario === 'result read') {
        expect(invoked).not.toHaveBeenCalled(); expect(result.message.value).toEqual(rejected.value)
        expect(store.loadEffect(key)).toMatchObject({ state: 'result', confirmationCount: 1 })
      } else {
        expect(invoked).toHaveBeenCalledOnce(); expect(result.message.value.content).toBe('Executed once')
        if (scenario === 'prepared read') expect(store.loadEffect(key)).toBeUndefined()
        else expect(store.loadEffect(key)).toMatchObject({ state: 'result', effectAttempt: 1, recoveryMode: scenario === 'prepared confirm' ? 'confirm' : 'idempotent' })
      }
    }
  })

  it.each(['completed', 'running', 'foreign', 'uncertain'] as const)('recovers only an owned managed outcome: %s', async kind => {
    const h = await fixture(), tool = call('managed', 'mcp_mutation', {})
    const invoked = vi.fn(() => { throw new Error('Must not replay') })
    const definition: ToolDefinition = { name: tool.name, description: '', inputSchema: z.object({}), execute: invoked }
    h.options.definitions = [definition]
    await h.begin([tool])
    const key = { ...h.request, callId: tool.id }
    h.store.prepareEffect(key, 'confirm')
    h.store.armEffect(key, { kind: 'fixture', target: { remote: 'operation' } })
    const message: ConversationMessage = { kind: 'tool', name: tool.name, resultFor: tool.providerCallId,
      content: 'saved outcome', artifact: new Uint8Array([0, 255]) }
    const record: AgentManagedCallRecord = { id: tool.artifacts['managed-call'], threadId: h.request.threadId,
      runId: kind === 'foreign' ? 'another-run' : h.runId, kind: 'mcp', summary: 'remote',
      status: kind === 'running' || kind === 'uncertain' ? kind : 'completed', outputChars: 0, createdAt: 'time', updatedAt: 'time',
      ...(kind === 'running' ? { detachedAt: 'time' } : { result: 'saved-reference', outcome: { result_format: 'conversation' } }) }
    const remove = vi.fn(), read = vi.fn(async () => message)
    const execute = createConversationToolExecutor({ store: h.store, definitions: [native(definition)], preparation: h.options,
      operations: h.operations, planning: false, persistFileChange: h.changes, managed: { format: 'conversation', get: () => record, remove, read } })
    const state = h.store.load('thread')!, result = await execute(state.calls[0], state, h.request, observer())
    expect(invoked).not.toHaveBeenCalled()
    if (kind === 'foreign' || kind === 'uncertain') {
      expect(result.kind).toBe('wait')
      expect(read).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
    } else {
      if (result.kind !== 'result') throw new Error('Expected managed result')
      if (kind === 'running') {
        expect(JSON.parse(String(result.message.value.content))).toMatchObject({ call_id: record.id, status: 'running' })
        expect(h.store.loadEffect(key)!.state).toBe('intent')
        expect(remove).not.toHaveBeenCalled()
      } else {
        expect(result.message.value.artifact).toEqual(message.artifact)
        expect(h.store.loadEffect(key)!.state).toBe('result')
        expect(remove).toHaveBeenCalledWith(record.id, record.threadId)
        remove.mockClear()
        await execute(state.calls[0], state, h.request, observer())
        expect(read).toHaveBeenCalledOnce()
        expect(remove).toHaveBeenCalledWith(record.id, record.threadId)
      }
    }
  })
})
