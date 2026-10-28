import type { ConversationMessage } from '../../runtime/conversationMessage'
import { requireObjectToolCall } from '../../runtime/toolInput'
import Database from 'better-sqlite3'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentAccessMode } from '@shared/agentTypes'
import type { ResolvedModelConfig } from '@shared/types'
import type { ExecutionContext, ExecutionPendingCall, ExecutionState } from '../../runtime/executionState'
import { ProjectRulesError, ProjectRulesRequestBudgetError } from '../../runtime/errors'
import { projectRulesText, ruleScopeIds } from '../../runtime/projectRules'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import { NativeExecutionStore, nativeExecutionSchema } from './nativeExecutionStore'
import { conversationRuleSystemMessage, conversationRuleToolRejection, prepareConversationRules, preflightConversationRules, type ConversationRulesOptions } from './conversationRules'
import { prepareConversationModelCall } from './conversationRequest'

vi.mock('../config/apiKeys', () => ({ resolveModelApiKey: (model: ResolvedModelConfig) => model.apiKey }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
vi.mock('../projectStore', () => ({ getProject: vi.fn() }))
vi.mock('../gitChanges', () => ({ queryGitChanges: vi.fn() }))

const roots: string[] = [], databases: Database.Database[] = []
afterEach(async () => { for (const db of databases.splice(0)) if (db.open) db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const context = (): ExecutionContext => ({ modelCalls: 0, todos: [] })
const scope = (state: ExecutionState) => ({ threadId: state.threadId, runId: state.runId, expectedRevisionId: state.revisionId })
function database(file = ':memory:', create = true) {
  const db = new Database(file); databases.push(db); db.pragma('foreign_keys = ON'); if (create) db.exec(nativeExecutionSchema); return db
}
async function fixture(mode: AgentAccessMode = 'strict_approval') {
  await mkdir(join(process.cwd(), 'tmp'), { recursive: true })
  const root = await realpath(await mkdtemp(join(process.cwd(), 'tmp', 'native-rules-')))
  roots.push(root)
  for (const name of ['one', 'two', 'two/sub']) await mkdir(join(root, name), { recursive: true })
  for (const name of ['one', 'two']) {
    await writeFile(join(root, name, '.git'), 'fixture')
    await writeFile(join(root, name, 'AGENTS.md'), `${name} ORIGINAL RULE`)
  }
  const options: ConversationRulesOptions = { runId: 'run', folders: [join(root, 'one'), join(root, 'two/sub')],
    primaryFolder: join(root, 'one'), accessMode: () => mode }
  return { root, options }
}
function begin(store: NativeExecutionStore) {
  store.start({ threadId: 'thread', runId: 'run', context: context(), messages: [{ id: 'user', value: { kind: 'user', content: 'Do the task' } }] })
}
function call(path: string): ExecutionPendingCall & { args: Record<string, unknown> } {
  return { id: 'app-call', providerCallId: 'provider-call', name: 'write_file', args: { path, content: 'new' }, index: 0, prepared: false,
    artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, `app-call:${purpose}`])) as ExecutionPendingCall['artifacts'] }
}
const model: ResolvedModelConfig = { id: 'fixture', displayName: '', providerId: 'provider', providerName: 'Fixture', protocol: 'openai_chat_completions',
  baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-key', parameters: {}, parameterPresetMode: 'none', capabilities: { vision: true, toolUse: true },
  stream: false, maxContextTokens: 12000, maxOutputTokens: 1000, contextCompressionThreshold: 0.8, contextCompressionEnabled: true }

function chatResponse() {
  return Response.json({ id: 'response', object: 'chat.completion', created: 1, model: 'fixture',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }] })
}
async function requestFixture() {
  const { root, options } = await fixture('full_access'), prepared = await prepareConversationRules(context(), options)
  if (prepared.kind !== 'ready') throw new Error('Expected captured rules')
  return { root, options, prepared, input: { systemMessage: conversationRuleSystemMessage({ kind: 'system', content: 'Instructions' }, prepared.context, 'run'),
    messages: [{ kind: 'user' as const, content: 'Inspect' }], tools: [] as unknown[], requiresTools: false, projectRules: prepared.context.projectRules } }
}

describe('native project rules and durable preparation approval', () => {
  it('includes updated Responses instructions in the next required-context budget', async () => {
    const { input } = await requestFixture(), selected = { ...model, protocol: 'openai_responses' as const, maxContextTokens: 7000, parameters: { instructions: '' } }
    const fetch = vi.fn(async () => Response.json({ id: 'response', object: 'response', created_at: 1, status: 'completed', model: 'fixture',
      output: [{ id: 'message', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done', annotations: [] }] }] }))
    const config = { runId: 'run', signal: new AbortController().signal, resolveModel: async () => selected, providerFetch: fetch }
    await (await prepareConversationModelCall(selected, input, config)).invoke()
    selected.parameters.instructions = 'x'.repeat(24000)
    await expect(prepareConversationModelCall(selected, input, config)).rejects.toThrow('safe capacity')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('budgets pending images and the active protocol transport text at the final rule guard', async () => {
    const { input } = await requestFixture()
    const messages: ConversationMessage[] = [{ kind: 'user', content: 'Inspect' }, { kind: 'assistant', content: '', calls: [{ id: 'image', name: 'capture', args: {} }] },
      { kind: 'tool', resultFor: 'image', content: [{ type: 'text', text: 'Image metadata '.repeat(100) },
        { type: 'image', source_type: 'base64', data: 'AA==', mime_type: 'image/png' }] }, { kind: 'user', content: 'Continue' }]
    const selected: ResolvedModelConfig = { ...model, protocol: 'openai_responses', maxContextTokens: 3000 }
    const fetch = vi.fn(async () => Response.json({ id: 'response', object: 'response', created_at: 1, status: 'completed', model: 'fixture',
      output: [{ id: 'message', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done', annotations: [] }] }] }))
    const config = { runId: 'run', signal: new AbortController().signal, resolveModel: async () => selected, providerFetch: fetch }
    await (await prepareConversationModelCall(selected, { ...input, messages }, config)).invoke()
    selected.protocol = 'openai_chat_completions'
    await expect(prepareConversationModelCall(selected, { ...input, messages }, config)).rejects.toThrow('safe capacity is 1744')
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('checks changed model capacity on the next request using the same frozen rules', async () => {
    const { input } = await requestFixture(), snapshot = structuredClone(input.projectRules), selected = { ...model, maxContextTokens: 21000 }
    const fetch = vi.fn(async () => chatResponse()), config = { runId: 'run', signal: new AbortController().signal, resolveModel: async () => selected, providerFetch: fetch }
    await (await prepareConversationModelCall(selected, input, config)).invoke()
    selected.maxContextTokens = 1100
    await expect(prepareConversationModelCall(selected, input, config)).rejects.toThrow('safe capacity is 0')
    expect(fetch).toHaveBeenCalledOnce()
    expect(input.projectRules).toEqual(snapshot)
  })

  it('includes structured response declarations in the final rule budget', async () => {
    const { input } = await requestFixture(), selected = { ...model, maxContextTokens: 3000 }, fetch = vi.fn(async () => chatResponse())
    const tools = [{ type: 'function', function: { name: 'report', description: 'x'.repeat(16000), parameters: { type: 'object', properties: {} } } }]
    await expect(prepareConversationModelCall(selected, { ...input, tools }, { runId: 'run', signal: new AbortController().signal,
      resolveModel: async () => selected, providerFetch: fetch })).rejects.toThrow('safe capacity is 1744')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['removed rules', 'larger tools', 'larger messages'])('rechecks a prepared native request after %s', async change => {
    const { input } = await requestFixture(), selected = { ...model, maxContextTokens: 2500 }, fetch = vi.fn(async () => chatResponse())
    const changed = { ...input,
      ...(change === 'removed rules' ? { systemMessage: { kind: 'system' as const, content: 'Summary without rules' } } : {}),
      ...(change === 'larger messages' ? { messages: [{ kind: 'user' as const, content: 'x'.repeat(12000) }] } : {}),
      ...(change === 'larger tools' ? { tools: [{ type: 'function', function: { name: 'large', description: 'x'.repeat(12000), parameters: { type: 'object', properties: {} } } }] } : {}) }
    await expect(prepareConversationModelCall(selected, changed, { runId: 'run', signal: new AbortController().signal,
      resolveModel: async () => selected, providerFetch: fetch })).rejects.toBeInstanceOf(ProjectRulesError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('retains frozen rules outside summarized history and validates every repeated send', async () => {
    const { root, input } = await requestFixture(), sent: string[] = []
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => { sent.push(String(init?.body)); return chatResponse() })
    const config = { runId: 'run', signal: new AbortController().signal, resolveModel: async () => model, providerFetch: fetch }
    for (const content of ['SUMMARY', 'SMALLER SUMMARY']) {
      await writeFile(join(root, 'one/AGENTS.md'), 'Changed after capture')
      const request = await prepareConversationModelCall(model, { ...input, messages: [{ kind: 'user', content, context: { summary: true } }] }, config)
      const result = await request.invoke()
      expect(result.message.context?.projectRulesReceipt).toMatchObject({ scopes: ruleScopeIds(input.projectRules!), runId: 'run' })
    }
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(sent.every(text => text.includes('one ORIGINAL RULE') && !text.includes('Changed after capture'))).toBe(true)
  })

  it('persists completed preparation and refuses changed inputs without reinterpreting the saved decision', async () => {
    const { root, options } = await fixture('full_access'), file = join(root, 'rules.sqlite')
    const initial = await prepareConversationRules(context(), options)
    if (initial.kind !== 'ready') throw new Error('Expected captured rules')
    const request = call(join(root, 'one/new.txt'))
    request.args.summary = 'Write fixture'
    const receipt = { runId: 'run', scopes: ruleScopeIds(initial.context.projectRules!), minimumTokens: 10, budget: 10000 }
    const result = await preflightConversationRules(initial.context, [request], receipt, options)
    if (result.kind !== 'ready') throw new Error('Expected completed preparation')
    let db = database(file), store = new NativeExecutionStore(db)
    begin(store)
    store.acceptModel(scope(store.load('thread')!), { id: 'model', value: { kind: 'assistant', content: '',
      calls: [{ id: request.providerCallId, name: request.name, args: request.args }] } }, [request], initial.context)
    store.prepareTools(scope(store.load('thread')!), [{ callId: request.id, args: request.args }], [], result.context)
    db.close(); db = database(file, false); store = new NativeExecutionStore(db)
    const saved = store.load('thread')!
    await writeFile(join(root, 'one/AGENTS.md'), 'Changed on disk')
    const repeated = await preflightConversationRules(saved.context, saved.calls, receipt, options)
    expect(repeated).toEqual({ kind: 'ready', context: saved.context, calls: saved.calls })
    const changed = structuredClone(saved.calls)
    requireObjectToolCall(changed[0]).args.path = join(root, 'two/new.txt')
    await expect(preflightConversationRules(saved.context, changed, receipt, options)).rejects.toThrow('prepared rule inputs changed')
    expect(store.load('thread')).toEqual(saved)
  })

  it('captures external rules in strict mode without pausing and retains the frozen snapshot after reopening', async () => {
    const { root, options } = await fixture(), file = join(root, 'execution.sqlite')
    const prepared = await prepareConversationRules(context(), options)
    expect(prepared.kind).toBe('ready')
    expect(prepared.context.projectRules!.documents.map(document => document.content)).toEqual(['one ORIGINAL RULE', 'two ORIGINAL RULE'])
    let db = database(file), store = new NativeExecutionStore(db)
    begin(store); store.prepareContext(scope(store.load('thread')!), prepared.context)
    await writeFile(join(root, 'two/AGENTS.md'), 'Changed after capture')
    db.close(); db = database(file, false); store = new NativeExecutionStore(db)
    const repeated = await prepareConversationRules(store.load('thread')!.context, options)
    expect(repeated.context).toEqual(prepared.context)
    expect(repeated.context.rulePreparation!.reads).toEqual([])
    expect(store.load('thread')!.approvals).toEqual([])
    const next = await prepareConversationRules(repeated.context, { ...options, runId: 'next' })
    expect(next.kind).toBe('ready')
    expect(next.context.projectRules!.documents.map(document => document.content)).toContain('Changed after capture')
  })

  it.each(['strict_approval', 'smart_approval', 'full_access'] as const)('includes validated external rules in a read-only preview in %s', async mode => {
    const { options } = await fixture(mode)
    const result = await prepareConversationRules(context(), options)
    expect(result.kind).toBe('ready')
    expect(result.context.rulePreparation!.reads).toEqual([])
    expect(result.context.projectRules!.documents).toHaveLength(2)
  })

  it('reads newly discovered external rules automatically but withholds writes generated without them', async () => {
    const { root, options } = await fixture(); options.folders = [join(root, 'one')]
    const prepared = await prepareConversationRules(context(), options)
    const tool = call(join(root, 'two/new.txt'))
    const result = await preflightConversationRules(prepared.context, [tool],
      { runId: 'run', scopes: ruleScopeIds(prepared.context.projectRules!), minimumTokens: 100, budget: 10000 }, options)
    expect(result.kind).toBe('ready')
    expect(result.context.projectRules!.blockedCalls).toEqual([tool.id])
    expect(await conversationRuleToolRejection(result.context, tool, options)).toContain('Newly discovered scoped project rules')
    expect(projectRulesText(result.context.projectRules!)).toContain('two ORIGINAL RULE')
    expect(result.context.rulePreparation!.reads).toEqual([])
  })

  it('guards the final request and records the exact rule scopes on a complete SDK response', async () => {
    const { options } = await fixture('smart_approval'), prepared = await prepareConversationRules(context(), options)
    if (prepared.kind !== 'ready') throw new Error('Expected ready rules')
    const systemMessage = conversationRuleSystemMessage({ kind: 'system', content: 'Instructions' }, prepared.context, 'run')
    const input = { systemMessage, messages: [{ kind: 'user' as const, content: 'Do the task' }], tools: [], requiresTools: false, projectRules: prepared.context.projectRules }
    const fetch = vi.fn(async () => Response.json({ id: 'response', object: 'chat.completion', created: 1, model: 'fixture',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }] }))
    const config = { runId: 'run', signal: new AbortController().signal, resolveModel: async () => model, providerFetch: fetch }
    const request = await prepareConversationModelCall(model, input, config), result = await request.invoke()
    expect(result.message.context!.projectRulesReceipt).toMatchObject({ runId: 'run', scopes: ruleScopeIds(prepared.context.projectRules!) })
    await expect(prepareConversationModelCall(model, { ...input, systemMessage: { kind: 'system', content: 'Rules removed' } }, config)).rejects.toThrow('removed')
    await expect(prepareConversationModelCall(model, { ...input, projectRules: { ...input.projectRules!, runId: 'other' } }, config)).rejects.toThrow('another run')
    await expect(prepareConversationModelCall(model, { ...input, messages: [{ kind: 'user', content: 'huge task '.repeat(9000) }] }, config)).rejects.toBeInstanceOf(ProjectRulesError)
    await expect(prepareConversationModelCall(model, { ...input, messages: [{ kind: 'user', content: 'history '.repeat(9000) }, { kind: 'assistant', content: 'old' }, ...input.messages] }, config)).rejects.toBeInstanceOf(ProjectRulesRequestBudgetError)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('preserves a recovered sibling result while discovering external rules', async () => {
    const { root, options } = await fixture(); options.folders = [join(root, 'one')]
    const initial = await prepareConversationRules(context(), options)
    if (initial.kind !== 'ready') throw new Error('Expected local rules')
    const store = new NativeExecutionStore(database()); begin(store)
    const left = call(join(root, 'two/new.txt')), right = { ...call(join(root, 'one/done.txt')), id: 'right', providerCallId: 'right-provider' }
    store.acceptModel(scope(store.load('thread')!), { id: 'model', value: { kind: 'assistant', content: '',
      calls: [left, right].map(call => ({ id: call.providerCallId, name: call.name, args: call.args })) } }, [left, right], initial.context)
    store.settleCall(scope(store.load('thread')!), right.id, { id: 'known-result', value: { kind: 'tool', content: 'already completed', resultFor: right.providerCallId } })
    const state = store.load('thread')!, prepared = await preflightConversationRules(state.context, state.calls,
      { runId: 'run', scopes: ruleScopeIds(initial.context.projectRules!), minimumTokens: 100, budget: 10000 }, options)
    expect(prepared.kind).toBe('ready')
    expect(prepared.context.projectRules!.blockedCalls).toContain(left.id)
    expect(store.load('thread')!.calls[1].result!.value.content).toBe('already completed')
    store.finish(scope(store.load('thread')!), 'cancelled')
    expect(store.load('thread')!.messages.at(-1)!.id).toBe('known-result')
  })
})
