import Database from 'better-sqlite3'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import type { ExecutionContext } from '../../runtime/executionState'
import { decodeExecutionValue } from '../../runtime/executionValue'
import { NativeExecutionStore, nativeExecutionSchema } from './nativeExecutionStore'
import { projectConversationSupervision, reconcileConversationSupervision, type ConversationSupervisionOptions } from './conversationSupervision'

const id = '11111111-1111-4111-8111-111111111111', child = '22222222-2222-4222-8222-222222222222'
const context = (): ExecutionContext => ({ modelCalls: 0, todos: [] })
const task = { id, kind: 'mcp' as const, status: 'completed' as const, summary: 'remote operation' }
const subagent = { id: child, agentName: 'helper', status: 'completed' as const, description: 'Review files' }
function evidence(kind: 'managed' | 'subagent' = 'managed'): ConversationMessage[] {
  const name = kind === 'managed' ? 'read_call' : 'read_subagent'
  return [{ kind: 'assistant', content: '', calls: [{ id: 'read', name, args: kind === 'managed' ? { call_id: id } : { subagent_id: child } }] },
    { kind: 'tool', resultFor: 'read', name, content: JSON.stringify({ ok: true, terminal: true,
      ...(kind === 'managed' ? { call_id: id, status: 'completed', output_chars_total: 0 } : { subagent_id: child }) }) }]
}

describe('native background supervision', () => {
  it('retains observed evidence across SQLite reopen until its owner acknowledges it', async () => {
    await mkdir(join(process.cwd(), 'tmp'), { recursive: true })
    const root = await mkdtemp(join(process.cwd(), 'tmp', 'native-supervision-')), file = join(root, 'execution.sqlite')
    let db = new Database(file)
    try {
      db.pragma('foreign_keys=ON'); db.exec(nativeExecutionSchema)
      let store = new NativeExecutionStore(db), active = true
      const resolve = vi.fn(), options = { managed: { unresolved: () => active ? [task] : [], resolve } }
      store.start({ threadId: 'thread', runId: 'run', context: context(), messages: [] })
      const retained = await reconcileConversationSupervision(context(), evidence(), options)
      store.prepareContext({ threadId: 'thread', runId: 'run', expectedRevisionId: store.load('thread')!.revisionId }, retained!)
      expect(resolve).toHaveBeenCalledWith(id)
      const row = db.prepare('SELECT context_value FROM execution_state').get() as { context_value: Uint8Array }
      expect(decodeExecutionValue(row.context_value)).toEqual({ model_calls: 0, todos: [], observed_managed_calls: { [id]: true } })
      db.close(); db = new Database(file); store = new NativeExecutionStore(db)
      const restored = store.load('thread')!.context
      expect(restored.observedManagedCalls).toEqual({ [id]: true })
      expect(await reconcileConversationSupervision(restored, [], options)).toBeUndefined()
      resolve.mockImplementation(() => { active = false })
      const accepted = await reconcileConversationSupervision(restored, [], options)
      expect(accepted?.observedManagedCalls).toBeUndefined()
      store.prepareContext({ threadId: 'thread', runId: 'run', expectedRevisionId: store.load('thread')!.revisionId }, accepted!)
      expect(store.load('thread')!.context).toEqual(context())
    } finally { db.close(); await rm(root, { recursive: true, force: true }) }
  })

  it.each(['unpaired', 'partial', 'running', 'wrong-name', 'text-only', 'nonterminal-completed', 'missing-output-total'] as const)('does not acknowledge %s evidence', async kind => {
    const messages = evidence(), resolve = vi.fn()
    if (kind === 'unpaired') messages.shift()
    else if (kind === 'partial') messages[0].partial = true
    else if (kind === 'running') messages[1].content = JSON.stringify({ ok: true, terminal: false, call_id: id, status: 'running', output_chars_total: 0 })
    else if (kind === 'wrong-name') messages[1].name = 'read_call_output'
    else if (kind === 'nonterminal-completed') messages[1].content = JSON.stringify({ ok: true, terminal: false, call_id: id, status: 'completed', output_chars_total: 0 })
    else if (kind === 'missing-output-total') messages[1].content = JSON.stringify({ ok: true, terminal: true, call_id: id, status: 'completed' })
    else messages[1] = { kind: 'user', content: messages[1].content }
    expect(await reconcileConversationSupervision(context(), messages, { managed: { unresolved: () => [task], resolve } })).toBeUndefined()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('acknowledges every terminal result from a bulk read and removes only resolved prompt entries', async () => {
    const ids = ['12121212-1212-8121-8121-121212121212', '34343434-3434-8343-8343-343434343434',
      '56565656-5656-8565-8565-565656565656', '78787878-7878-8787-8787-787878787878',
      '90909090-9090-8909-8909-909090909090', 'abababab-abab-8bab-8bab-abababababab']
    const resolved = new Set<string>(), tasks = ids.map(id => ({ ...task, id })), resolve = vi.fn((id: string) => { resolved.add(id) })
    const options = { managed: { unresolved: () => tasks.filter(task => !resolved.has(task.id)), resolve } }
    const system: ConversationMessage = { kind: 'system', content: 'Original instructions' }, tools = [{ name: 'read_call' }]
    const first = await projectConversationSupervision(system, tools, options)
    for (const id of ids) expect(first.systemMessage.content).toContain(id)
    const messages: ConversationMessage[] = [
      { kind: 'assistant', content: '', calls: [{ id: 'bulk', name: 'read_call', args: {} }] },
      { kind: 'tool', resultFor: 'bulk', name: 'read_call', content: JSON.stringify({ ok: true, count: tasks.length,
        calls: tasks.map(task => ({ ok: true, call_id: task.id, status: task.status, terminal: true, output_chars_total: 0 })) }) }
    ]
    const original = structuredClone(messages)
    await reconcileConversationSupervision(context(), messages, options)
    expect(resolve.mock.calls.map(([id]) => id)).toEqual(ids)
    expect(await projectConversationSupervision(system, tools, options)).toEqual({ systemMessage: system, requiresTools: false })
    expect(system.content).toBe('Original instructions')
    expect(messages).toEqual(original)
  })

  it('correlates simultaneous terminal observations with their own tool calls', async () => {
    const second = '33333333-3333-4333-8333-333333333333', resolve = vi.fn()
    const messages: ConversationMessage[] = [
      { kind: 'assistant', content: '', calls: [{ id: 'read-one', name: 'read_call', args: { call_id: id } },
        { id: 'read-two', name: 'read_call', args: { call_id: second } }] },
      { kind: 'tool', resultFor: 'read-two', name: 'read_call', content: JSON.stringify({ ok: true, call_id: second, status: 'completed', terminal: true, output_chars_total: 0 }) },
      { kind: 'tool', resultFor: 'read-one', name: 'read_call', content: JSON.stringify({ ok: true, call_id: id, status: 'completed', terminal: true, output_chars_total: 0 }) }
    ]
    const options = { managed: { unresolved: () => [task, { ...task, id: second }], resolve } }
    const acknowledged = await reconcileConversationSupervision(context(), messages, options)
    expect(new Set(resolve.mock.calls.map(([id]) => id))).toEqual(new Set([id, second]))
    expect(acknowledged?.observedManagedCalls).toEqual({ [id]: true, [second]: true })
    resolve.mockClear()
    messages[1].content = messages[2].content
    messages[2].content = JSON.stringify({ ok: true, call_id: second, status: 'completed', terminal: true, output_chars_total: 0 })
    expect(await reconcileConversationSupervision(context(), messages, options)).toBeUndefined()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('uses the existing prompts and requires the actual selected supervision tools', async () => {
    const options: ConversationSupervisionOptions = { managed: { unresolved: () => [task] },
      subagents: { unresolved: () => [subagent], resolve: vi.fn() } }
    const tools = [{ name: 'read_call' }, { type: 'function', function: { name: 'wait_subagent' } }]
    const result = await projectConversationSupervision({ kind: 'system', content: 'Instructions' }, tools, options)
    expect(result.requiresTools).toBe(true)
    expect(result.systemMessage.content).toContain(id)
    expect(result.systemMessage.content).toContain(child)
    expect(String(result.systemMessage.content).indexOf('<subagent_supervision>')).toBeLessThan(String(result.systemMessage.content).indexOf('<background_call_supervision>'))
    await expect(projectConversationSupervision({ kind: 'system', content: '' }, [], options)).rejects.toThrow('supervision tools are unavailable')
  })

  it('waits for entered acknowledgements in both task owners before reporting failure', async () => {
    let release!: () => void, done = false
    const pending = new Promise<void>(resolve => { release = resolve }), failure = new Error('owner failed')
    const options: ConversationSupervisionOptions = { managed: { unresolved: () => [task], resolve: () => { throw failure } },
      subagents: { unresolved: () => [subagent], resolve: () => pending } }
    const execution = reconcileConversationSupervision(context(), [...evidence(), ...evidence('subagent')], options).finally(() => { done = true })
    const rejected = expect(execution).rejects.toBe(failure)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(done).toBe(false)
    release(); await rejected
  })

  it('rejects malformed persisted observation flags without replacing the current context', () => {
    const db = new Database(':memory:')
    try {
      db.exec(nativeExecutionSchema)
      const store = new NativeExecutionStore(db)
      store.start({ threadId: 'thread', runId: 'run', messages: [], context: context() })
      const state = store.load('thread')!
      expect(() => store.prepareContext({ threadId: 'thread', runId: 'run', expectedRevisionId: state.revisionId },
        { ...context(), observedSubagents: { [child]: false } as unknown as Record<string, true> })).toThrow('Invalid persisted background')
      expect(store.load('thread')).toEqual(state)
    } finally { db.close() }
  })
})
