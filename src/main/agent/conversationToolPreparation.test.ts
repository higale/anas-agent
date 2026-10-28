import { requireObjectToolCall } from '../../runtime/toolInput'
import Database from 'better-sqlite3'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { z as z3 } from 'zod/v3'
import { planningToolSpec } from '../../runtime/planning'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import type { ExecutionState, ExecutionToolCall } from '../../runtime/executionState'
import { defineContentTool } from '../../runtime/toolDefinition'
import { invokeCapability } from '../../runtime/toolInvocation'
import { fileToolDefinitions } from '../llm/fileTools'
import { NativeExecutionStore, nativeExecutionSchema } from './nativeExecutionStore'
import { prepareConversationToolBatch, resolveConversationToolApprovals, type ConversationToolPreparationOptions } from './conversationToolPreparation'
import { prepareConversationRules } from './conversationRules'
import { ruleScopeIds } from '../../runtime/projectRules'
import { authorizationInputHash } from '../../runtime/authorizationReceipts'

const roots: string[] = [], databases: Database.Database[] = []
afterEach(async () => { for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const scope = (state: ExecutionState) => ({ threadId: state.threadId, runId: state.runId, expectedRevisionId: state.revisionId })
function call(id: string, name: string, args: Record<string, unknown>): ExecutionToolCall {
  return { id, name, args, providerCallId: `provider:${id}`,
    artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, `${id}:${purpose}`])) as ExecutionToolCall['artifacts'] }
}
async function fixture() {
  await mkdir(join(process.cwd(), 'tmp'), { recursive: true })
  const root = await realpath(await mkdtemp(join(process.cwd(), 'tmp', 'native-preflight-'))); roots.push(root)
  await mkdir(join(root, 'project')); await mkdir(join(root, 'outside'))
  await writeFile(join(root, 'project/.git'), 'fixture'); await writeFile(join(root, 'outside/.git'), 'fixture')
  const db = new Database(':memory:'); databases.push(db); db.pragma('foreign_keys=ON'); db.exec(nativeExecutionSchema)
  let failCommit = false
  const store = new NativeExecutionStore(db, () => { if (failCommit) throw new Error('commit failed') })
  const options: ConversationToolPreparationOptions = { runId: 'run', primaryFolder: join(root, 'project'), folders: [join(root, 'project')],
    accessMode: () => 'read_only_allowed', includeRules: false,
    definitions: [...fileToolDefinitions({ primaryFolder: join(root, 'project'), maxReadBytes: 10000, toolNames: ['read_file', 'write_file'] }), planningToolSpec] }
  function begin(calls: ExecutionToolCall[], context = { modelCalls: 0, todos: [] } as ExecutionState['context'], receipt?: unknown) {
    store.start({ threadId: 'thread', runId: 'run', context, messages: [{ id: 'user', value: { kind: 'user', content: 'Do work' } }] })
    store.acceptModel(scope(store.load('thread')!), { id: 'model', value: { kind: 'assistant', content: '',
      calls: calls.map(call => ({ id: call.providerCallId, name: call.name, args: call.args })), context: { projectRulesReceipt: receipt } } }, calls, { ...context, modelCalls: 1 })
  }
  async function prepare() {
    const state = store.load('thread')!, result = await prepareConversationToolBatch(state, options)
    if ('kind' in result) throw new Error('Unexpected context approval')
    store.prepareTools(scope(state), result.calls, result.approvals, result.context)
    return store.load('thread')!
  }
  return { root, db, store, options, begin, prepare, fail: (value: boolean) => { failCommit = value } }
}

describe('native complete tool batch preparation', () => {
  it.each([
    { format: 'Zod 3', schema: z3.object({ command: z3.string() }) },
    { format: 'Zod 4', schema: z.object({ command: z.string() }) },
    { format: 'JSON Schema', schema: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] } }
  ])('validates $format input before Shell inspection or approval and accepts a corrected call', async ({ schema }) => {
    const h = await fixture(), execute = vi.fn(async (_input: unknown) => 'Executed once')
    const definition = defineContentTool({ name: 'pwsh', description: 'Shell fixture', inputSchema: schema, execute })
    const inspect = vi.fn(async () => undefined), requiresApproval = vi.fn(async () => true)
    h.options.definitions = [definition]
    h.options.shell = { toolName: 'pwsh', analyzer: { inspect, requiresApproval }, accessMode: h.options.accessMode }
    h.begin([call('invalid', 'pwsh', { command: 3 })])
    const invalid = await h.prepare()
    expect(invalid.approvals).toEqual([])
    expect(invalid.calls[0].result?.value).toMatchObject({ resultStatus: 'error', content: expect.stringContaining('command') })
    expect(inspect).not.toHaveBeenCalled()
    expect(requiresApproval).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    h.store.finishBatch(scope(invalid))
    const current = h.store.load('thread')!, corrected = call('corrected', 'pwsh', { command: 'Get-Date' })
    h.store.acceptModel(scope(current), { id: 'corrected-model', value: { kind: 'assistant', content: '',
      calls: [{ id: corrected.providerCallId, name: corrected.name, args: corrected.args }] } }, [corrected], { ...current.context, modelCalls: 2 })
    const waiting = await h.prepare(), approval = waiting.approvals[0]
    expect(waiting.approvals).toHaveLength(1)
    expect(approval.request.actionRequests).toMatchObject([{ name: 'pwsh', args: { command: 'Get-Date' } }])
    expect(inspect).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
    resolveConversationToolApprovals(h.store, scope(waiting), [{ id: approval.id, generation: approval.generation, response: { decisions: [{ type: 'approve' }] } }])
    const saved = h.store.load('thread')!.calls[0]
    expect(saved.authorization?.approval).toBe('granted')
    expect(await invokeCapability(definition, saved.args, { callId: saved.id })).toEqual({ content: 'Executed once' })
    expect(execute).toHaveBeenCalledOnce()
    expect(h.store.readHistory('thread')!.messages.filter(message => message.value.resultFor === 'provider:invalid')).toHaveLength(1)
  })

  it('preserves cancellation during Shell inspection instead of returning a validation result', async () => {
    const h = await fixture(), controller = new AbortController(), reason = new Error('cancelled approval evaluation')
    h.options.signal = controller.signal
    h.options.definitions = [{ name: 'pwsh', inputSchema: z.object({ command: z.string() }) }]
    h.options.shell = { toolName: 'pwsh', accessMode: h.options.accessMode, analyzer: {
      inspect: vi.fn(async () => { controller.abort(reason); throw reason }), requiresApproval: vi.fn(async () => true)
    } }
    h.begin([call('shell', 'pwsh', { command: 'Get-Date' })])
    const before = h.store.load('thread')
    await expect(h.prepare()).rejects.toBe(reason)
    expect(h.store.load('thread')).toEqual(before)
  })

  it.each(['strict_approval', 'read_only_allowed', 'full_access'] as const)(
    'lets the model correct empty, missing and non-string paths in %s', async mode => {
      const h = await fixture()
      h.options.accessMode = () => mode
      await writeFile(join(h.root, 'project/note.txt'), 'read succeeded')
      const definition = fileToolDefinitions({ maxReadBytes: 10000, primaryFolder: h.options.primaryFolder, toolNames: ['read_file'] })[0]
      const execute = vi.spyOn(definition, 'execute')
      h.options.definitions = [definition]
      const calls = [call('empty', 'read_file', { path: '' }), call('missing', 'read_file', {}),
        call('number', 'read_file', { path: 3 }), call('corrected', 'read_file', { path: 'note.txt' })]
      h.begin([calls[0]])
      for (let index = 0; index < calls.length; index++) {
        if (index) {
          const state = h.store.load('thread')!, next = calls[index]
          h.store.acceptModel(scope(state), { id: 'model-' + index, value: { kind: 'assistant', content: '',
            calls: [{ id: next.providerCallId, name: next.name, args: next.args }] } }, [next], { ...state.context, modelCalls: index + 1 })
        }
        const prepared = await h.prepare()
        expect(prepared.approvals).toHaveLength(0)
        if (index < 3) {
          expect(prepared.calls[0].result?.value).toMatchObject({ resultStatus: 'error', content: expect.stringMatching(/path/i) })
          expect(execute).not.toHaveBeenCalled()
        } else {
          expect(prepared.calls[0].args).toEqual({ path: join(h.root, 'project/note.txt') })
          const result = await invokeCapability(definition, prepared.calls[0].args, { callId: calls[index].id })
          expect(String(result.content)).toContain('read succeeded')
          h.store.settleCall(scope(prepared), calls[index].id, { id: 'corrected-result', value: { kind: 'tool',
            resultFor: calls[index].providerCallId, content: String(result.content), resultStatus: 'success' } })
        }
        h.store.finishBatch(scope(h.store.load('thread')!))
      }
      const results = h.store.readHistory('thread')!.messages.filter(message => message.value.kind === 'tool')
      expect(results).toHaveLength(4)
      expect(execute).toHaveBeenCalledOnce()
      for (const item of calls) expect(results.filter(message => message.value.resultFor === item.providerCallId)).toHaveLength(1)
    })

  it.each(['pwsh', 'update_config', 'delete_file'] as const)('uses the current access mode for each %s batch and preserves approval choices', async name => {
    const h = await fixture()
    let mode: 'read_only_allowed' | 'full_access' = 'read_only_allowed'
    h.options.accessMode = () => mode
    h.options.definitions = [{ name, inputSchema: z.record(z.string(), z.unknown()) }]
    const inspect = vi.fn(async () => undefined)
    h.options.shell = { toolName: 'pwsh', analyzer: { inspect, requiresApproval: vi.fn(async () => true) }, accessMode: h.options.accessMode }
    const args = name === 'pwsh' ? { command: 'pwd' } : name === 'update_config'
      ? { config: 'settings', key: 'theme', value: 'dark' } : { path: join(h.root, 'outside/result.txt') }
    h.begin([call('operation', name, args)])
    const state = h.store.load('thread')!, before = structuredClone(state)
    for (const current of ['read_only_allowed', 'full_access', 'read_only_allowed'] as const) {
      mode = current
      const result = await prepareConversationToolBatch(state, h.options)
      if ('kind' in result) throw new Error('Unexpected rule wait')
      expect(result.approvals).toHaveLength(current === 'full_access' ? 0 : 1)
      if (current !== 'full_access') {
        expect(result.approvals![0].request.reviewConfigs).toEqual([{ actionName: name, allowedDecisions: ['approve', 'reject'] }])
        expect(result.approvals![0].request.actionRequests).toEqual([{ name, args,
          description: name === 'pwsh' ? 'Run a command with pwsh.' : name === 'update_config'
            ? 'Modify application configuration.' : 'Access a host file path outside the project folders.' }])
      }
      expect(result.calls[0].args).toEqual(args)
      expect(state).toEqual(before)
    }
  })

  it.each([true, false])('uses a saved restore target decision requiring approval %s without rewriting arguments', async requiresApproval => {
    const h = await fixture(), args = { operation_id: 'operation-1', request_id: 'origin-request' }
    const restore = call('restore', 'restore_file_edit', args)
    restore.authorization = { patch: { id: restore.id, name: restore.name, inputHash: authorizationInputHash(args),
      targets: [{ path: join(h.root, 'outside/file.txt'), lexicalPath: join(h.root, 'outside/file.txt'), locator: ['targets', 0, 'path'], kind: 'file', access: 'write' }],
      requiresApproval, humanApproved: false } }
    h.options.definitions = [{ name: restore.name, inputSchema: z.object({ operation_id: z.string(), request_id: z.string() }) }]
    h.begin([restore])
    const prepared = await h.prepare()
    expect(prepared.approvals).toHaveLength(requiresApproval ? 1 : 0)
    expect(prepared.calls[0].args).toEqual(args)
    expect(prepared.calls[0].args).not.toHaveProperty('resolved_path')
    expect(prepared.calls[0].authorization?.patch?.targets).toEqual(restore.authorization.patch!.targets)
  })

  it('does not inherit a prior run rule block when a new batch reuses a provider call identity', async () => {
    const h = await fixture()
    h.options.includeRules = true
    const previous = await prepareConversationRules({ modelCalls: 0, todos: [] }, { ...h.options, runId: 'previous' })
    if (previous.kind !== 'ready') throw new Error('Expected initial rules')
    previous.context.projectRules!.blockedCalls = ['reused-id']
    const current = await prepareConversationRules(previous.context, h.options)
    if (current.kind !== 'ready') throw new Error('Expected new run rules')
    expect(current.context.projectRules!.blockedCalls).toEqual([])
    h.options.definitions = [{ name: 'update_config', inputSchema: z.record(z.string(), z.unknown()) }]
    h.begin([call('reused-id', 'update_config', { config: 'settings', key: 'theme', value: 'dark' })], current.context,
      { runId: 'run', scopes: ruleScopeIds(current.context.projectRules!), minimumTokens: 10, budget: 10000 })
    const prepared = await h.prepare()
    expect(prepared.approvals[0].callIds).toEqual(['reused-id'])
    expect(prepared.calls[0].result).toBeUndefined()
  })

  it('retains a completed approval while validating the remaining batch and saved target identity', async () => {
    const h = await fixture(), external = join(h.root, 'outside/new.txt')
    h.begin([call('write', 'write_file', { path: external, content: 'new' }), call('plan-1', 'write_todos', { todos: [] }),
      call('plan-2', 'write_todos', { todos: [] }), call('invalid', 'write_file', { path: external })])
    const state = h.store.load('thread')!
    for (const item of state.calls) item.authorization = { approval: 'granted' }
    const result = await prepareConversationToolBatch(state, h.options)
    if ('kind' in result) throw new Error('Unexpected rule wait')
    expect(result.approvals).toEqual([])
    expect(result.calls[0].authorization).toEqual({ approval: 'granted' })
    expect(result.calls.slice(1).every(item => item.result?.value.resultStatus === 'error')).toBe(true)
    state.calls[0].authorization!.patch = { id: 'write', name: 'write_file', inputHash: authorizationInputHash({ path: 'changed' }),
      requiresApproval: true, humanApproved: true, targets: [] }
    const mismatch = await prepareConversationToolBatch(state, h.options)
    if ('kind' in mismatch) throw new Error('Unexpected rule wait')
    expect(mismatch.calls[0].result?.value.content).toContain('no longer matches')
  })

  it('validates inputs and competing plans before persisting exact paths and an atomic approval', async () => {
    const h = await fixture(), external = join(h.root, 'outside/new.txt')
    h.begin([call('read', 'read_file', { path: 'local.txt' }), call('write', 'write_file', { path: external, content: 'new' }),
      call('invalid', 'write_file', { path: external }), call('plan-1', 'write_todos', { todos: [] }), call('plan-2', 'write_todos', { todos: [] })])
    const waiting = await h.prepare()
    expect(waiting.phase).toBe('waiting')
    expect(waiting.approvals).toHaveLength(1)
    expect(waiting.approvals[0].callIds).toEqual(['write'])
    expect(requireObjectToolCall(waiting.calls[0]).args.path).toBe(join(h.root, 'project/local.txt'))
    expect(waiting.calls[2].result!.value.content).toContain('invalid input')
    expect(waiting.calls.slice(3).every(call => String(call.result!.value.content).includes('multiple times in parallel'))).toBe(true)
    expect(waiting.calls[1].authorization?.patch).toMatchObject({ id: 'write', humanApproved: false, requiresApproval: true })
    expect(waiting.calls[1].args).toEqual({ path: external, content: 'new' })
    const approval = waiting.approvals[0], answers = [{ id: approval.id, generation: approval.generation, response: { decisions: [{ type: 'approve' }] } }]
    h.db.exec('CREATE TABLE intent (consumed INTEGER); INSERT INTO intent VALUES (0)')
    h.fail(true)
    expect(() => resolveConversationToolApprovals(h.store, scope(waiting), answers, () => { h.db.exec('UPDATE intent SET consumed=1') })).toThrow('commit failed')
    expect(h.db.prepare('SELECT * FROM intent').get()).toEqual({ consumed: 0 })
    expect(h.store.load('thread')!.calls[1].authorization!.patch!.humanApproved).toBe(false)
    h.fail(false)
    resolveConversationToolApprovals(h.store, scope(waiting), answers, () => { h.db.exec('UPDATE intent SET consumed=1') })
    expect(h.store.load('thread')!.phase).toBe('tools')
    expect(h.store.load('thread')!.calls[1].authorization).toMatchObject({ approval: 'granted', patch: { humanApproved: true } })
    expect(() => resolveConversationToolApprovals(h.store, scope(waiting), answers)).toThrow()
  })

  it('rejects all unanswered siblings while preserving an already saved result', async () => {
    const h = await fixture()
    h.begin([call('known', 'read_file', { path: 'known.txt' }), call('auto', 'read_file', { path: 'pending.txt' }),
      call('write', 'write_file', { path: join(h.root, 'outside/new.txt'), content: 'new' })])
    h.store.settleCall(scope(h.store.load('thread')!), 'known', { id: 'known-result', value: { kind: 'tool', resultFor: 'provider:known', content: 'saved result' } })
    const waiting = await h.prepare(), approval = waiting.approvals[0]
    expect(() => resolveConversationToolApprovals(h.store, scope(waiting), [{ id: approval.id, generation: 'old', response: { decisions: [{ type: 'reject' }] } }])).toThrow('generation changed')
    resolveConversationToolApprovals(h.store, scope(waiting), [{ id: approval.id, generation: approval.generation, response: { decisions: [{ type: 'reject', message: 'Keep the file' }] } }])
    const after = h.store.load('thread')!
    expect(after.calls[0].result!.value.content).toBe('saved result')
    expect(after.calls[1].result!.value.content).toContain('Another action in this batch was rejected')
    expect(after.calls[2].result!.value.content).toBe('Keep the file')
    h.store.finishBatch(scope(after))
    expect(h.store.load('thread')!.messages.slice(-3).map(record => record.id)).toEqual(['known-result', 'auto:result', 'write:result'])
  })

  it('does not persist schema defaults or transformations and rejects unavailable capabilities', async () => {
    const h = await fixture(), execute = vi.fn(async (input: { count: number }) => input)
    const tool = defineContentTool({ name: 'fixture', description: '', inputSchema: z.object({ count: z.number().default(0) }).transform(input => ({ count: input.count + 1 })), execute })
    h.options.definitions = [tool]
    h.begin([call('custom', tool.name, {}), call('missing', 'unavailable', {})])
    const prepared = await h.prepare()
    expect(prepared.calls[0].args).toEqual({})
    expect(prepared.calls[1].result!.value.content).toContain('not available')
    expect(execute).not.toHaveBeenCalled()
    expect(await invokeCapability(tool, prepared.calls[0].args, { callId: 'custom' })).toEqual({ content: { count: 1 } })
    expect(prepared.calls[0].args).toEqual({})
    expect(execute).toHaveBeenCalledOnce()
  })

  it('finishes rule-read approval before ordinary authorization and withholds unseen-rule writes', async () => {
    const h = await fixture()
    h.options.includeRules = true; h.options.accessMode = () => 'strict_approval'
    await writeFile(join(h.root, 'outside/AGENTS.md'), 'External write rules')
    const rules = await prepareConversationRules({ modelCalls: 0, todos: [] }, h.options)
    if (rules.kind !== 'ready') throw new Error('Expected local initial rules')
    h.begin([call('write', 'write_file', { path: join(h.root, 'outside/new.txt'), content: 'new' })], rules.context,
      { runId: 'run', scopes: ruleScopeIds(rules.context.projectRules!), minimumTokens: 10, budget: 10000 })
    const state = h.store.load('thread')!, pending = await prepareConversationToolBatch(state, h.options)
    if (!('kind' in pending)) throw new Error('Expected rule read approval')
    h.store.waitForContext(scope(state), pending.approval, pending.context)
    expect(h.store.load('thread')!.calls[0].prepared).toBe(false)
    h.store.resolveContextWait(scope(h.store.load('thread')!), pending.approval.id, pending.approval.generation, 'approve')
    const after = await h.prepare()
    expect(after.approvals).toEqual([])
    expect(after.calls[0].result!.value.content).toContain('Newly discovered scoped project rules')
    expect(after.calls[0].authorization).toBeUndefined()
  })

  it('rejects changed arguments after a saved preparation instead of silently replacing its receipt', async () => {
    const h = await fixture(), inspect = vi.fn(async () => undefined), original = call('command', 'pwsh', { command: 'Get-Date' })
    original.authorization = { shell: { id: original.id, name: original.name, inputHash: authorizationInputHash(original.args),
      humanApproved: false, requiresApproval: true } }
    h.options.shell = { toolName: 'pwsh', analyzer: { inspect, requiresApproval: vi.fn() }, accessMode: h.options.accessMode }
    h.options.definitions = [{ name: 'pwsh', inputSchema: z.object({ command: z.string() }) }]
    h.begin([original])
    const state = h.store.load('thread')!
    state.calls[0].args = { command: 'Get-Location' }
    const prepared = await prepareConversationToolBatch(state, h.options)
    if ('kind' in prepared) throw new Error('Unexpected context approval')
    expect(prepared.calls[0].result?.value.content).toContain('saved authorization no longer matches')
    expect(prepared.approvals).toEqual([])
    expect(inspect).not.toHaveBeenCalled()
    expect(h.store.load('thread')!.calls[0].args).toEqual(original.args)
  })

  it('validates Shell input before inspection and persists approval on the original arguments', async () => {
    const h = await fixture(), inspect = vi.fn(async () => undefined)
    h.options.shell = { toolName: 'pwsh', analyzer: { inspect, requiresApproval: vi.fn(async () => true) }, accessMode: h.options.accessMode }
    h.options.definitions = [{ name: 'pwsh', inputSchema: z.object({ command: z.string() }) }]
    h.begin([call('invalid', 'pwsh', { command: 42 }), call('command', 'pwsh', { command: 'Write-Output hello' })])
    const prepared = await h.prepare(), approval = prepared.approvals[0]
    expect(inspect).toHaveBeenCalledOnce()
    expect(prepared.calls[0].result!.value.content).toContain('invalid input')
    expect(approval.callIds).toEqual(['command'])
    expect(prepared.calls[1].args).toEqual({ command: 'Write-Output hello' })
    expect(() => resolveConversationToolApprovals(h.store, scope(prepared), [{ id: approval.id, generation: approval.generation,
      response: { decisions: [{ type: 'approve' }, { type: 'reject' }] } }])).toThrow('decision count')
    resolveConversationToolApprovals(h.store, scope(prepared), [{ id: approval.id, generation: approval.generation, response: { decisions: [{ type: 'approve' }] } }])
    expect(h.store.load('thread')!.calls[1].authorization!.shell!.humanApproved).toBe(true)
  })
})
