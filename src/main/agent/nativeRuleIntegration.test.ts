import { fileToolDefinitions } from '../llm/fileTools'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ResolvedModelConfig } from '@shared/types'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { conversationExecution } from '../../runtime/conversationExecution'
import type { RunObserver } from '../../runtime/runExecution'
import { ToolRunScope } from '../../runtime/toolEvents'
import { defineContentTool, type ToolDefinition } from '../../runtime/toolDefinition'
import { toolResultMessage } from '../../runtime/toolResultMessage'
import { FileEditStore } from '../fileEditStore'
import { filePatchSchema } from '../filePatch'
import { NativeExecutionStore, nativeExecutionSchema, type NativeExecutionCommit } from './nativeExecutionStore'
import { createConversationModelPreparation, type ConversationModelExecutionOptions } from './conversationModelExecution'
import { prepareConversationToolBatch, type ConversationToolPreparationOptions } from './conversationToolPreparation'
import { createConversationToolExecutor } from './conversationToolExecution'
import { modelToolDeclaration } from './modelToolDeclarations'
import { saveToolResultFile } from './toolResultFile'

vi.mock('../config/apiKeys', () => ({ resolveModelApiKey: (model: ResolvedModelConfig) => model.apiKey }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
vi.mock('../projectStore', () => ({ getProject: vi.fn() }))
vi.mock('../gitChanges', () => ({ queryGitChanges: vi.fn() }))
const roots: string[] = [], databases: Database.Database[] = []
afterEach(async () => { for (const db of databases.splice(0)) if (db.open) db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
type ScriptCall = { id: string; name: string; args: unknown }
const writeCall = (id: string, path: string): ScriptCall => ({ id, name: 'delete_file', args: { path } })
function capability(name: string, inputSchema: unknown, execute = vi.fn(async (_input: Record<string, unknown>) => 'done')) {
  return { definition: defineContentTool({ name, description: name, inputSchema, execute }), execute }
}
async function fixture(capacity = 20000) {
  const root = await realpath(await mkdtemp(join(process.cwd(), 'tmp', 'native-rule-integration-'))); roots.push(root)
  await mkdir(join(root, 'child')); await writeFile(join(root, '.git'), 'fixture')
  await writeFile(join(root, 'AGENTS.md'), 'ROOT RULE'); await writeFile(join(root, 'child/AGENTS.md'), 'CHILD RULE')
  const file = join(root, 'execution.sqlite'), db = new Database(file); databases.push(db); db.pragma('foreign_keys=ON'); db.exec(nativeExecutionSchema)
  const commits: NativeExecutionCommit[] = []
  const store = new NativeExecutionStore(db, commit => { commits.push(commit) }), runId = randomUUID(), operations = new ToolRunScope(), definitions: ToolDefinition[] = []
  const fileEditStore = new FileEditStore(join(root, 'file-edits'))
  const selected: ResolvedModelConfig = { id: 'fixture', displayName: '', providerId: 'provider', providerName: 'Fixture', protocol: 'openai_chat_completions',
    baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-key', parameters: {}, parameterPresetMode: 'none', capabilities: { vision: true, toolUse: true },
    stream: false, maxContextTokens: capacity + 1000, maxOutputTokens: 1000, contextCompressionThreshold: 0.8, contextCompressionEnabled: false }
  const preparation: ConversationToolPreparationOptions = { runId, primaryFolder: root, folders: [root], accessMode: () => 'full_access',
    includeRules: true, definitions, fileEditStore }
  const batches: ScriptCall[][] = [], prompts: string[] = [], requests: Record<string, unknown>[] = []
  let index = 0
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); requests.push(body)
    const summary = body.messages.length === 1
    if (!summary) prompts.push(body.messages.filter((message: { role: string }) => message.role === 'system').map((message: { content: string }) => message.content).join('\n'))
    const calls = summary ? [] : batches[index++] ?? []
    return Response.json({ id: randomUUID(), object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0,
      finish_reason: calls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: summary ? 'Continue the requested edit.' : '',
        ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}) } }] })
  })
  const modelOptions: ConversationModelExecutionOptions = { store, resolveModel: async () => selected, systemPrompt: () => 'BASE',
    tools: () => definitions.map(tool => modelToolDeclaration(tool)), requiresTools: () => definitions.length > 0,
    maxModelCalls: 20, rules: preparation, outputLanguage: { code: 'en', name: 'English' }, providerFetch: fetch,
    compressionTracking: { onCompressionStart: vi.fn(() => randomUUID()), onCompressionCompleted: vi.fn(), onCompressionFailed: vi.fn() },
    saveToolResult: content => saveToolResultFile(content, join(root, 'tool_results')) }
  const observer: RunObserver = { started: vi.fn(), startModel: vi.fn(() => randomUUID()), discardModel: vi.fn(), model: vi.fn(), tool: vi.fn(), approval: vi.fn(), committed: vi.fn(async () => {}) }
  const request = { threadId: 'thread', runId, signal: new AbortController().signal }, hooks: { beforeTool?(): Promise<void> } = {}
  function execution(active = store) {
    const native = definitions.map(definition => ({ ...definition, async execute(args, context) {
      const call = active.load('thread')!.calls.find(call => call.id === context.callId)!
      return toolResultMessage(await definition.execute(args, context), { name: definition.name, callId: call.providerCallId!, metadata: definition.metadata })
    } } satisfies ToolDefinition<ConversationMessage>))
    const dispatch = createConversationToolExecutor({ store: active, definitions: native, preparation, operations, planning: false, persistFileChange: () => {} })
    return conversationExecution({ store: active, enter: async () => {}, prepareModel: createConversationModelPreparation({ ...modelOptions, store: active }),
      afterModel: async () => ({ kind: 'complete' }), prepareTools: state => prepareConversationToolBatch(state, preparation),
      executeTool: async (...args) => { await hooks.beforeTool?.(); return dispatch(...args) },
      directions: async () => [], drain: () => operations.drain(), retry: { maxRetries: 0 } })
  }
  async function run(user: ConversationMessage = { kind: 'user', content: 'Edit' }) {
    store.start({ threadId: 'thread', runId, context: { modelCalls: 0, todos: [] }, messages: [{ id: 'user', value: user }] })
    const output = await execution().execute('input', request, observer)
    if (output.result.status === 'rejected') throw output.result.reason
    return store.readHistory('thread')!.messages.map(message => message.value)
  }
  return { root, file, db, store, commits, runId, fileEditStore, selected, definitions, preparation, batches, prompts, requests, fetch, modelOptions, observer, request, hooks, execution, run }
}

describe('native project rules in durable tool execution', () => {
  it('dispatches calls against their originating rule budget before enforcing a changed model window', async () => {
    const h = await fixture(), write = capability('delete_file', z.object({ path: z.string() }))
    h.definitions.push(write.definition); h.batches.push([writeCall('write', join(h.root, 'a'))], [])
    h.observer.model = event => { if (event.kind === 'completed') h.selected.maxContextTokens = 1100 }
    await expect(h.run()).rejects.toThrow('safe capacity is 0')
    expect(write.execute).toHaveBeenCalledOnce(); expect(h.fetch).toHaveBeenCalledOnce()
  })

  it('includes the original request when checking scoped rules after Skill projection', async () => {
    const h = await fixture(2000), write = capability('delete_file', z.object({ path: z.string() }))
    await writeFile(join(h.root, 'child/AGENTS.md'), 'RULE '.repeat(1000))
    h.definitions.push(write.definition); h.batches.push([writeCall('large', join(h.root, 'child/a'))], [])
    const command = `/edit ${'User requirements. '.repeat(170)}`.trim()
    const skill = '<skill>\n<name>edit</name>\n<path>/skills/edit/SKILL.md</path>\nEdit the requested files.\n</skill>'
    await expect(h.run({ kind: 'user', content: `${command}\n\n${skill}`, context: { displayText: command } })).rejects.toThrow('indivisible')
    expect(write.execute).not.toHaveBeenCalled(); expect(h.fetch).toHaveBeenCalledOnce()
  })

  it.each([null, 'wrong', 3, []])('returns malformed HTTP arguments %j before optional target inspection and accepts correction', async args => {
    const h = await fixture(), http = capability('http_request', z.object({ url: z.string() }))
    h.definitions.push(http.definition); h.batches.push([{ id: 'invalid', name: 'http_request', args }], [{ id: 'corrected', name: 'http_request', args: { url: 'https://example.test' } }], [])
    const messages = await h.run()
    expect(messages.filter(message => message.kind === 'tool')).toMatchObject([{ resultFor: 'invalid', resultStatus: 'error' }, { resultFor: 'corrected', resultStatus: 'success' }])
    expect(http.execute).toHaveBeenCalledOnce()
  })

  it('requires both source and destination rules before dispatching a complete patch', async () => {
    const h = await fixture(), patch = capability('apply_patch', filePatchSchema)
    await mkdir(join(h.root, 'target')); await writeFile(join(h.root, 'target/AGENTS.md'), 'DESTINATION RULE')
    const args = { summary: 'Edit together', patch: '*** Begin Patch\n*** Add File: new.txt\n+new\n*** Update File: child/a\n*** Move to: target/b\n@@\n before\n*** End Patch' }
    h.definitions.push(patch.definition); h.batches.push([{ id: 'discover', name: 'apply_patch', args }], [{ id: 'decided', name: 'apply_patch', args }], [])
    h.modelOptions.onRequest = () => { if (h.prompts.length === 1) expect(patch.execute).not.toHaveBeenCalled() }
    const messages = await h.run()
    expect(h.prompts[1]).toContain('CHILD RULE'); expect(h.prompts[1]).toContain('DESTINATION RULE')
    expect(patch.execute).toHaveBeenCalledOnce(); expect(patch.execute.mock.calls[0][0]).toEqual(args)
    expect(messages.find(message => message.resultFor === 'discover')?.content).toContain('NOT EXECUTED')
  })

  it('does not dispatch any part of a patch whose combined scopes exceed capacity', async () => {
    const h = await fixture(2500), patch = capability('apply_patch', filePatchSchema)
    await mkdir(join(h.root, 'target')); await writeFile(join(h.root, 'child/AGENTS.md'), 'A '.repeat(2200)); await writeFile(join(h.root, 'target/AGENTS.md'), 'B '.repeat(2200))
    h.definitions.push(patch.definition); h.batches.push([{ id: 'large', name: 'apply_patch', args: { summary: 'Move together', patch: '*** Begin Patch\n*** Update File: child/a\n*** Move to: target/b\n@@\n before\n*** End Patch' } }], [])
    await expect(h.run()).rejects.toThrow('indivisible apply_patch')
    expect(patch.execute).not.toHaveBeenCalled(); expect(h.fetch).toHaveBeenCalledOnce()
  })

  it('previews a patch as a read while adopting newly discovered scoped rules', async () => {
    const h = await fixture(), preview = capability('apply_patch', filePatchSchema, vi.fn(async () => 'previewed'))
    const args = { dry_run: true, patch: '*** Begin Patch\n*** Add File: child/new.txt\n+new\n*** End Patch' }
    h.definitions.push(preview.definition); h.batches.push([{ id: 'preview', name: 'apply_patch', args }], [])
    const messages = await h.run()
    expect(preview.execute).toHaveBeenCalledOnce(); expect(preview.execute.mock.calls[0][0]).toEqual(args)
    expect(messages.find(message => message.resultFor === 'preview')?.content).toBe('previewed')
    expect(h.prompts[1]).toContain('CHILD RULE')
  })

  it('rejects a patch symlink retargeted after rule preflight', async () => {
    const h = await fixture(), patch = capability('apply_patch', filePatchSchema)
    await writeFile(join(h.root, 'a'), 'before\n'); await writeFile(join(h.root, 'child/b'), 'before\n'); await symlink(join(h.root, 'a'), join(h.root, 'link'), 'file')
    h.definitions.push(patch.definition); h.batches.push([{ id: 'race', name: 'apply_patch', args: { summary: 'Update link', patch: '*** Begin Patch\n*** Update File: link\n@@\n-before\n+after\n*** End Patch' } }], [])
    let retargeted = false
    h.hooks.beforeTool = async () => {
      const state = h.store.load('thread')!
      if (!retargeted && state.calls.some(call => call.prepared)) {
        retargeted = true; await unlink(join(h.root, 'link')); await symlink(join(h.root, 'child/b'), join(h.root, 'link'), 'file')
      }
    }
    const messages = await h.run()
    expect(retargeted).toBe(true); expect(patch.execute).not.toHaveBeenCalled()
    expect(messages.find(message => message.resultFor === 'race')?.content).toContain('targets changed')
  })

  it.each(['restore', 'empty-path', 'blank-request-id'])('returns %s target errors and accepts the next corrected call', async kind => {
    const h = await fixture(), write = capability('delete_file', z.object({ path: z.string() })), restore = capability('restore_file_edit', z.object({ operation_id: z.string(), request_id: z.string().optional() }))
    h.definitions.push(write.definition, restore.definition)
    h.batches.push([kind === 'empty-path' ? writeCall('bad', '') : { id: 'bad', name: 'restore_file_edit', args: { operation_id: 'mistyped/id', ...(kind === 'blank-request-id' ? { request_id: '  ' } : {}) } }], [writeCall('corrected', join(h.root, 'a'))], [])
    const messages = await h.run(), rejected = messages.find(message => message.resultFor === 'bad')
    expect(rejected?.content).toContain('NOT EXECUTED'); expect(rejected?.content).toContain(kind === 'empty-path' ? 'Invalid file path' : 'operation_id is invalid')
    expect(restore.execute).not.toHaveBeenCalled(); expect(write.execute).toHaveBeenCalledOnce()
  })
  it('freezes additional roots but projects their rules only when targeted', async () => {
    const h = await fixture(), other = await fixture(), write = capability('delete_file', z.object({ path: z.string() }))
    await writeFile(join(other.root, 'AGENTS.md'), 'OTHER ROOT RULE')
    h.preparation.folders.push(other.root)
    h.definitions.push(write.definition); h.batches.push([writeCall('first', join(other.root, 'a'))], [writeCall('second', join(other.root, 'a'))], [])
    h.modelOptions.onRequest = () => { if (h.prompts.length === 1) expect(write.execute).not.toHaveBeenCalled() }
    await h.run()
    expect(h.prompts[0]).not.toContain('OTHER ROOT RULE'); expect(h.prompts[1]).toContain('OTHER ROOT RULE')
    expect(h.prompts[1]).not.toContain(`Source: ${JSON.stringify(join(h.root, 'AGENTS.md'))}`)
    expect(write.execute).toHaveBeenCalledOnce()
  })

  it('preflights the whole parallel batch before writes while keeping reads runnable', async () => {
    const h = await fixture(), write = capability('delete_file', z.object({ path: z.string() }), vi.fn(async input => {
      expect(h.prompts.at(-1)).toContain('CHILD RULE'); return `wrote:${input.path}`
    })), read = capability('read_file', z.object({ path: z.string() }), vi.fn(async () => 'read result'))
    h.definitions.push(write.definition, read.definition)
    h.batches.push([writeCall('root-first', join(h.root, 'a')), writeCall('child-first', join(h.root, 'child/b')), { id: 'read-first', name: 'read_file', args: { path: join(h.root, 'a') } }],
      [writeCall('child-redecided', join(h.root, 'child/c'))], [])
    h.modelOptions.onRequest = () => { if (h.prompts.length === 1) expect(write.execute).not.toHaveBeenCalled() }
    const messages = await h.run()
    expect(h.prompts[0]).not.toContain('CHILD RULE'); expect(write.execute).toHaveBeenCalledOnce()
    expect(write.execute.mock.calls[0][0].path).toBe(join(h.root, 'child/c')); expect(read.execute).toHaveBeenCalledOnce()
    expect(messages.filter(message => message.kind === 'tool' && String(message.content).includes('NOT EXECUTED'))).toHaveLength(2)
  })

  it('restores adopted rules from a durable pre-request snapshot after disk rules change', async () => {
    const h = await fixture(), write = capability('delete_file', z.object({ path: z.string() })), copy = join(h.root, 'saved-before-request.sqlite')
    h.definitions.push(write.definition); h.batches.push([writeCall('one', join(h.root, 'child/a'))], [writeCall('two', join(h.root, 'child/b'))], [])
    h.modelOptions.providerFetch = async (...args) => {
      if (h.prompts.length === 1) { await h.db.backup(copy); throw new Error('simulated stopped process') }
      return h.fetch(...args)
    }
    await expect(h.run()).rejects.toMatchObject({ cause: { message: 'simulated stopped process' } })
    expect(write.execute).not.toHaveBeenCalled()
    await writeFile(join(h.root, 'child/AGENTS.md'), 'CHANGED')
    const db = new Database(copy); databases.push(db); db.pragma('foreign_keys=ON')
    const store = new NativeExecutionStore(db)
    expect(store.load('thread')?.phase).toBe('prepare_model')
    h.modelOptions.providerFetch = h.fetch
    const resumed = await h.execution(store).execute('continue', h.request, h.observer)
    if (resumed.result.status === 'rejected') throw resumed.result.reason
    expect(store.load('thread')?.phase).toBe('completed'); expect(write.execute).toHaveBeenCalledOnce()
    expect(h.prompts[1]).toContain('CHILD RULE'); expect(h.prompts[1]).not.toContain('CHANGED')
  })

  it('terminates oversized indivisible scopes without another model call or write', async () => {
    const h = await fixture(1500), write = capability('delete_file', z.object({ path: z.string() }))
    await writeFile(join(h.root, 'child/AGENTS.md'), 'LONG '.repeat(1500))
    h.definitions.push(write.definition); h.batches.push([writeCall('large', join(h.root, 'child/a'))], [])
    await expect(h.run()).rejects.toThrow('indivisible')
    expect(write.execute).not.toHaveBeenCalled(); expect(h.fetch).toHaveBeenCalledOnce()
    expect(h.store.load('thread')?.phase).toBe('failed')
  })

  it('reads verified rules outside trusted folders without approval in strict mode', async () => {
    const h = await fixture()
    h.preparation.folders = [join(h.root, 'child')]; h.preparation.primaryFolder = join(h.root, 'child'); h.preparation.accessMode = () => 'strict_approval'
    await h.run()
    expect(h.store.load('thread')!.approvals).toEqual([])
    expect(h.fetch).toHaveBeenCalledOnce(); expect(h.store.load('thread')?.phase).toBe('completed')
  })

  it('rejects an oversized rule union but allows model-selected independent batches', async () => {
    const h = await fixture(2000), write = capability('delete_file', z.object({ path: z.string() }))
    await mkdir(join(h.root, 'other')); await writeFile(join(h.root, 'child/AGENTS.md'), 'A '.repeat(1500)); await writeFile(join(h.root, 'other/AGENTS.md'), 'B '.repeat(1500))
    const a = join(h.root, 'child/a'), b = join(h.root, 'other/b')
    h.definitions.push(write.definition); h.batches.push([writeCall('batch-a', a), writeCall('batch-b', b)], [writeCall('select-a', a)], [writeCall('write-a', a)], [writeCall('select-b', b)], [writeCall('write-b', b)], [])
    const messages = await h.run()
    expect(write.execute).toHaveBeenCalledTimes(2)
    expect(messages.filter(message => message.kind === 'tool' && String(message.content).includes('rule union'))).toHaveLength(2)
  })

  it('checks both ends and descendant scopes before dispatching a directory move', async () => {
    const h = await fixture(), move = capability('move_file', z.object({ source: z.string(), destination: z.string() }))
    await mkdir(join(h.root, 'child/deep')); await writeFile(join(h.root, 'child/deep/AGENTS.md'), 'DEEP RULE')
    await mkdir(join(h.root, 'target')); await writeFile(join(h.root, 'target/AGENTS.md'), 'DESTINATION RULE')
    const args = { source: join(h.root, 'child'), destination: join(h.root, 'target') }
    h.definitions.push(move.definition); h.batches.push([{ id: 'first', name: 'move_file', args }], [{ id: 'again', name: 'move_file', args }], [])
    h.modelOptions.onRequest = () => { if (h.prompts.length === 1) expect(move.execute).not.toHaveBeenCalled() }
    await h.run()
    expect(h.prompts[1]).toContain('DEEP RULE'); expect(h.prompts[1]).toContain('DESTINATION RULE'); expect(move.execute).toHaveBeenCalledOnce()
  })

  it('retains terminal budget failure after reopening so repaired files cannot restart the failed run', async () => {
    const h = await fixture(1500), write = capability('delete_file', z.object({ path: z.string() }))
    await writeFile(join(h.root, 'child/AGENTS.md'), 'LONG '.repeat(1500))
    h.definitions.push(write.definition); h.batches.push([writeCall('large', join(h.root, 'child/a'))], [])
    await expect(h.run()).rejects.toThrow('indivisible')
    const failed = h.store.load('thread')!
    expect(failed.phase).toBe('failed'); expect(h.commits.at(-1)?.error).toContain('indivisible')
    h.db.close(); await writeFile(join(h.root, 'child/AGENTS.md'), 'SHORT')
    const db = new Database(h.file); databases.push(db); db.pragma('foreign_keys=ON')
    const store = new NativeExecutionStore(db), resumed = await h.execution(store).execute('continue', h.request, h.observer)
    expect(resumed.result.status).toBe('rejected'); expect(store.load('thread')).toEqual(failed)
    expect(write.execute).not.toHaveBeenCalled(); expect(h.fetch).toHaveBeenCalledOnce()
  })

  it('compacts a complete tool result against capacity reserved for adopted rules', async () => {
    const h = await fixture(4000), write = capability('delete_file', z.object({ path: z.string() }), vi.fn(async () => 'SUCCESS '.repeat(400)))
    await writeFile(join(h.root, 'child/AGENTS.md'), 'R '.repeat(6100))
    h.selected.contextCompressionEnabled = true; h.selected.contextCompressionThreshold = 0.75
    h.definitions.push(write.definition); h.batches.push([writeCall('discover', join(h.root, 'child/a'))], [writeCall('write', join(h.root, 'child/a'))], [])
    await h.run()
    expect(write.execute).toHaveBeenCalledOnce()
    const sent = h.requests.map(request => JSON.stringify(request))
    expect(sent.some(text => text.includes('Tool result compacted for model context'))).toBe(true)
    expect(h.prompts.at(-1)).toContain('R '.repeat(6100))
    expect(sent.at(-1)).not.toContain('SUCCESS '.repeat(400))
    expect(h.store.readHistory('thread')!.messages.find(message => message.value.resultFor === 'write')?.value.content).toBe('SUCCESS '.repeat(400))
  })
  it.each(['write_file', 'apply_patch'] as const)('withholds the original %s transaction for new scoped rules and writes only the next model decision', async name => {
    const h = await fixture()
    h.definitions.push(...fileToolDefinitions({ maxReadBytes: 1000000, primaryFolder: h.root, requestId: h.runId,
      fileEditStore: h.fileEditStore, toolNames: [name] }))
    const args = name === 'write_file' ? { path: 'child/file.txt', content: 'complete content' }
      : { patch: '*** Begin Patch\n*** Add File: a.txt\n+root\n*** Add File: child/b.txt\n+child\n*** End Patch' }
    h.batches.push([{ id: 'original', name, args }], [{ id: 'redecided', name, args }], [])
    const messages = await h.run(), outputs = messages.filter(message => message.kind === 'tool')
    expect(outputs).toHaveLength(2)
    expect(outputs[0]).toMatchObject({ resultFor: 'original', resultStatus: 'error', content: expect.stringContaining('NOT EXECUTED') })
    expect(outputs[1]).toMatchObject({ resultFor: 'redecided', content: expect.stringContaining('"ok":true') })
    expect(await h.fileEditStore.listEditRecordsForRequest(h.runId)).toHaveLength(1)
    if (name === 'write_file') expect(await readFile(join(h.root, 'child/file.txt'), 'utf8')).toBe('complete content')
    else {
      expect(await readFile(join(h.root, 'a.txt'), 'utf8')).toBe('root\n')
      expect(await readFile(join(h.root, 'child/b.txt'), 'utf8')).toBe('child\n')
    }
  })
})
