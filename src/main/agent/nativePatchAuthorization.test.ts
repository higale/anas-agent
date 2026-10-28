import { resolveFilePatchTargets } from '../filePatch'
import { captureFilePatchPreimages } from '../filePatchState'
import { projectInterruptPathPreviews } from './approvalPathPreview'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentAccessMode } from '@shared/agentTypes'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import type { ExecutionState, ExecutionToolCall } from '../../runtime/executionState'
import type { RunObserver } from '../../runtime/runExecution'
import type { ToolDefinition } from '../../runtime/toolDefinition'
import { ToolRunScope } from '../../runtime/toolEvents'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import { toolResultMessage } from '../../runtime/toolResultMessage'
import { FileEditStore, pathExists } from '../fileEditStore'
import { fileToolDefinitions } from '../llm/fileTools'
import { NativeExecutionStore, nativeExecutionSchema } from './nativeExecutionStore'
import { prepareConversationToolBatch, resolveConversationToolApprovals, type ConversationToolPreparationOptions } from './conversationToolPreparation'
import { createConversationToolExecutor } from './conversationToolExecution'

const roots: string[] = [], databases: Database.Database[] = []
afterEach(async () => { for (const db of databases.splice(0)) if (db.open) db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
type Call = { id: string; name: string; args: Record<string, unknown> }
const scope = (state: ExecutionState) => ({ threadId: state.threadId, runId: state.runId, expectedRevisionId: state.revisionId })
async function fixture() {
  const root = await realpath(await mkdtemp(join(process.cwd(), 'tmp', 'native-patch-authorization-'))); roots.push(root)
  const workspace = join(root, 'project'), outside = join(root, 'outside'), file = join(root, 'execution.sqlite')
  await mkdir(workspace); await mkdir(outside)
  let db = new Database(file); databases.push(db); db.pragma('foreign_keys=ON'); db.exec(nativeExecutionSchema)
  let store = new NativeExecutionStore(db), mode: AgentAccessMode = 'read_only_allowed'
  const runId = randomUUID(), fileEditStore = new FileEditStore(join(root, 'records')), operations = new ToolRunScope()
  const definitions = fileToolDefinitions({ maxReadBytes: 1000000, primaryFolder: workspace, requestId: runId, fileEditStore, toolNames: ['apply_patch', 'write_file', 'restore_file_edit'] })
  const options: ConversationToolPreparationOptions = { runId, primaryFolder: workspace, folders: [workspace], fileEditStore, accessMode: () => mode, definitions, includeRules: false }
  const native = definitions.map(definition => ({ ...definition, async execute(args, context) {
    const call = store.load('thread')!.calls.find(call => call.id === context.callId)!
    return toolResultMessage(await definition.execute(args, context), { name: definition.name, callId: call.providerCallId!, metadata: definition.metadata })
  } } satisfies ToolDefinition<ConversationMessage>))
  const observer: RunObserver = { started: vi.fn(), startModel: vi.fn(() => 'model'), discardModel: vi.fn(), model: vi.fn(), tool: vi.fn(), approval: vi.fn(), committed: vi.fn(async () => {}) }
  function state() { return store.load('thread')! }
  function messages() { return store.readHistory('thread')!.messages.map(message => message.value) }
  async function stage(requests: Call[]) {
    if (!store.load('thread')) store.start({ threadId: 'thread', runId, context: { modelCalls: 0, todos: [] }, messages: [{ id: 'user', value: { kind: 'user', content: 'Edit files' } }] })
    const calls: ExecutionToolCall[] = requests.map(call => ({ ...call, providerCallId: call.id,
      artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, randomUUID()])) as ExecutionToolCall['artifacts'] }))
    store.acceptModel(scope(state()), { id: randomUUID(), value: { kind: 'assistant', content: '', calls: requests } }, calls, { ...state().context, modelCalls: state().context.modelCalls + 1 })
    const prepared = await prepareConversationToolBatch(state(), options)
    if ('kind' in prepared) throw new Error('Unexpected rule approval')
    store.prepareTools(scope(state()), prepared.calls, prepared.approvals, prepared.context)
  }
  function decide(decisions: Array<{ type: 'approve' | 'reject'; message?: string }>) {
    const approval = state().approvals[0]
    resolveConversationToolApprovals(store, scope(state()), [{ id: approval.id, generation: approval.generation, response: { decisions } }])
  }
  async function dispatch() {
    const execute = createConversationToolExecutor({ store, definitions: native, preparation: options, operations, planning: false, persistFileChange: () => {} })
    for (const call of state().calls) {
      if (call.result) continue
      const result = await execute(call, state(), { threadId: 'thread', runId, signal: new AbortController().signal }, observer)
      if (result.kind !== 'result') throw new Error('Unexpected effect recovery')
      store.settleCall(scope(state()), call.id, result.message)
    }
    store.finishBatch(scope(state())); await operations.drain()
    return messages().filter(message => message.kind === 'tool')
  }
  function reopen() { db.close(); db = new Database(file); databases.push(db); db.pragma('foreign_keys=ON'); store = new NativeExecutionStore(db) }
  return { root, workspace, outside, runId, fileEditStore, options, state, messages, stage, decide, dispatch, reopen, mode: (value: AgentAccessMode) => { mode = value } }
}

async function restoreArgs(h: Awaited<ReturnType<typeof fixture>>, paths: string[]) {
  const requestId = randomUUID(), patch = `*** Begin Patch\n${paths.map(path => `*** Add File: ${path}\n+created`).join('\n')}\n*** End Patch`
  const resolved = await resolveFilePatchTargets({ patch }, h.workspace)
  const source = await h.fileEditStore.executePatch(resolved.input, await captureFilePatchPreimages(resolved.targets), requestId, { operationId: randomUUID() })
  return { operation_id: source.operationId, request_id: requestId }
}

describe('native durable patch authorization', () => {
  it('reports one actionable syntax error without applying any part of the patch', async () => {
    const h = await fixture(), existing = join(h.workspace, 'existing.txt'), created = join(h.workspace, 'new.txt')
    await writeFile(existing, 'old\n')
    const patch = '*** Begin Patch\n*** Add File: new.txt\n+created\n*** Update File: existing.txt\n@@\nold\n+new\n*** End Patch'
    await h.stage([{ id: 'malformed', name: 'apply_patch', args: { patch } }])
    const [output] = await h.dispatch(), text = String(output.content)
    expect(output.resultStatus).toBe('error'); expect(text.match(/NOT EXECUTED:/g)).toHaveLength(1)
    expect(text).not.toContain('Error:'); expect(text).toContain("invalid hunk at line 6, Unexpected line found in update hunk: 'old'")
    expect(text).toContain("'-' (removed line)")
    expect(await readFile(existing, 'utf8')).toBe('old\n'); expect(await pathExists(created)).toBe(false)
    expect(await h.fileEditStore.listEditRecordsForRequest(h.runId)).toHaveLength(0)
  })

  it.each(['patch', 'input'])('accepts a corrected %s patch after a saved syntax error', async field => {
    const h = await fixture(), existing = join(h.workspace, 'existing.txt')
    await writeFile(existing, 'old\n')
    const patch = '*** Begin Patch\n*** Update File: existing.txt\n@@\nold\n+new\n*** End Patch'
    await h.stage([{ id: 'malformed', name: 'apply_patch', args: { [field]: patch } }]); await h.dispatch()
    await h.stage([{ id: 'corrected', name: 'apply_patch', args: { [field]: patch.replace('\nold\n', '\n-old\n') } }])
    const outputs = await h.dispatch()
    expect(outputs).toHaveLength(2); expect(outputs[0]).toMatchObject({ resultFor: 'malformed', resultStatus: 'error' })
    expect(outputs[1].content).toContain('"ok":true'); expect(await readFile(existing, 'utf8')).toBe('new\n')
    expect(await h.fileEditStore.listEditRecordsForRequest(h.runId)).toHaveLength(1)
  })

  it('withholds automatic and approved writes when a sibling is rejected after reopening', async () => {
    const h = await fixture(), paths = [join(h.workspace, 'inside.txt'), join(h.outside, 'first.txt'), join(h.outside, 'second.txt')]
    const calls = [{ id: 'invalid', name: 'write_file', args: { path: 'invalid.txt', content: 4 } }, ...paths.map((path, index) => ({ id: `write-${index}`, name: 'write_file', args: { path, content: 'New content' } }))]
    await h.stage(calls)
    expect(h.state().approvals[0].request.actionRequests).toMatchObject([{ name: 'write_file', args: { path: paths[1] } }, { name: 'write_file', args: { path: paths[2] } }])
    h.reopen(); h.decide([{ type: 'approve' }, { type: 'reject', message: 'Reconsider this batch' }])
    const outputs = await h.dispatch()
    expect(outputs).toHaveLength(calls.length); expect(new Set(outputs.map(message => message.resultFor)).size).toBe(calls.length)
    expect(outputs.every(message => message.resultStatus === 'error')).toBe(true)
    expect(h.messages().find(message => message.kind === 'assistant')?.calls?.map(call => call.id)).toEqual(calls.map(call => call.id))
    for (const path of [...paths, join(h.workspace, 'invalid.txt')]) expect(await pathExists(path)).toBe(false)
    expect(await h.fileEditStore.listEditRecordsForRequest(h.runId)).toHaveLength(0)
  })

  it.each(['approve', 'reject'] as const)('retains non-finite input errors and the valid write %s after reopening', async decision => {
    const h = await fixture(), path = join(h.outside, 'valid.txt')
    await h.stage([{ id: 'invalid', name: 'write_file', args: { path: 'invalid.txt', content: 'unused', extra: { number: Infinity } } },
      { id: 'valid', name: 'write_file', args: { path, content: 'approved content' } }])
    expect(h.state().calls[0].result?.value).toMatchObject({ resultStatus: 'error', content: expect.stringContaining('/extra/number') })
    expect(h.state().response!.value.calls?.map(call => call.id)).toEqual(['invalid', 'valid'])
    expect(h.state().approvals[0].request.actionRequests).toMatchObject([{ name: 'write_file', args: { path } }])
    expect(await pathExists(path)).toBe(false)
    h.reopen(); h.decide([{ type: decision }])
    const outputs = await h.dispatch()
    expect(outputs).toHaveLength(2); expect(outputs.find(message => message.resultFor === 'invalid')?.resultStatus).toBe('error')
    expect(await pathExists(join(h.workspace, 'invalid.txt'))).toBe(false)
    if (decision === 'approve') expect(await readFile(path, 'utf8')).toBe('approved content'); else expect(await pathExists(path)).toBe(false)
  })

  it('authorizes an external complete-file write using its saved target after reopening', async () => {
    const h = await fixture(), path = join(h.outside, 'new/file.txt')
    await h.stage([{ id: 'write', name: 'write_file', args: { summary: 'Create a file', path, content: 'complete\n+content', overwrite: false } }])
    expect(h.state().approvals).toHaveLength(1); expect(h.state().calls[0].authorization?.patch?.targets.map(target => target.path)).toEqual([path])
    expect(await pathExists(path)).toBe(false)
    h.reopen(); h.decide([{ type: 'approve' }])
    expect((await h.dispatch()).at(-1)?.content).toContain('"ok":true'); expect(await readFile(path, 'utf8')).toBe('complete\n+content')
  })

  it('rejects swapped approved symlink bindings instead of treating targets as an unordered set', async () => {
    const h = await fixture(), a = join(h.outside, 'a.txt'), b = join(h.outside, 'b.txt')
    await writeFile(a, 'before\n'); await writeFile(b, 'before\n')
    await symlink(a, join(h.workspace, 'first'), 'file'); await symlink(b, join(h.workspace, 'second'), 'file')
    await h.stage([{ id: 'batch', name: 'apply_patch', args: { patch: '*** Begin Patch\n*** Update File: first\n@@\n-before\n+first\n*** Update File: second\n@@\n-before\n+second\n*** End Patch' } }])
    await unlink(join(h.workspace, 'first')); await unlink(join(h.workspace, 'second'))
    await symlink(b, join(h.workspace, 'first'), 'file'); await symlink(a, join(h.workspace, 'second'), 'file')
    h.reopen(); h.decide([{ type: 'approve' }])
    expect((await h.dispatch()).at(-1)?.content).toContain('operation binding after authorization')
    expect(await readFile(a, 'utf8')).toBe('before\n'); expect(await readFile(b, 'utf8')).toBe('before\n')
  })

  it('saves every target before approval and executes the complete approved batch after reopening', async () => {
    const h = await fixture(), path = join(h.outside, 'a.txt'), inside = join(h.workspace, 'b.txt')
    await h.stage([{ id: 'batch', name: 'apply_patch', args: { patch: `*** Begin Patch\n*** Add File: ${path}\n+outside\n*** Add File: ${inside}\n+inside\n*** End Patch` } }])
    expect(h.state().approvals).toHaveLength(1); expect(h.state().calls[0].authorization?.patch?.targets.map(target => target.path)).toEqual([path, inside])
    expect(await pathExists(path)).toBe(false); expect(await pathExists(inside)).toBe(false)
    h.reopen(); h.decide([{ type: 'approve' }]); expect((await h.dispatch()).at(-1)?.content).toContain('"ok":true')
    expect(await readFile(path, 'utf8')).toBe('outside\n'); expect(await readFile(inside, 'utf8')).toBe('inside\n')
  })

  it.each(['apply_patch', 'write_file'])('rejects a changed symlink destination when the old %s approval resumes', async name => {
    const h = await fixture(), original = join(h.outside, 'a.txt'), replacement = join(h.outside, 'b.txt'), link = join(h.workspace, 'link')
    await writeFile(original, 'before\n'); await writeFile(replacement, 'before\n'); await symlink(original, link, 'file')
    await h.stage([{ id: 'batch', name, args: name === 'write_file' ? { path: 'link', content: 'after\n', overwrite: true }
      : { patch: '*** Begin Patch\n*** Update File: link\n@@\n-before\n+after\n*** End Patch' } }])
    expect(h.state().approvals).toHaveLength(1)
    await unlink(link); await symlink(replacement, link, 'file'); h.reopen(); h.decide([{ type: 'approve' }])
    expect((await h.dispatch()).at(-1)?.content).toContain('operation binding after authorization')
    expect(await readFile(original, 'utf8')).toBe('before\n'); expect(await readFile(replacement, 'utf8')).toBe('before\n')
    expect(await h.fileEditStore.listEditRecordsForRequest(h.runId)).toEqual([])
  })
  it('previews and authorizes every stored restoration target without adding model arguments', async () => {
    const h = await fixture(), paths = [join(h.outside, 'a.txt'), join(h.outside, 'b.txt')], args = await restoreArgs(h, paths)
    await h.stage([{ id: 'restore', name: 'restore_file_edit', args }])
    const state = h.state(), approval = state.approvals[0]
    expect(state.approvals).toHaveLength(1)
    const previews = await projectInterruptPathPreviews([{ id: approval.id, value: approval.request, approvalGeneration: approval.generation }], h.workspace,
      (_action, { actionIndex }) => state.calls.find(call => call.id === approval.callIds[actionIndex])?.authorization?.patch?.targets)
    expect(previews[0].pathPreviews?.map(item => item.absolutePath)).toEqual(paths)
    expect(JSON.stringify(approval.request)).not.toContain('resolved_path')
    h.reopen(); h.decide([{ type: 'approve' }]); expect((await h.dispatch()).at(-1)?.content).toContain('"ok":true')
    for (const path of paths) expect(await pathExists(path)).toBe(false)
  })

  it.each(['strict_approval', 'read_only_allowed', 'full_access'] as const)('uses saved read authorization for an outside patch preview in %s', async mode => {
    const h = await fixture(), path = join(h.outside, 'preview.txt'); h.mode(mode)
    await h.stage([{ id: 'preview', name: 'apply_patch', args: { dry_run: true, patch: `*** Begin Patch\n*** Add File: ${path}\n+preview\n*** End Patch` } }])
    expect(h.state().approvals).toHaveLength(mode === 'strict_approval' ? 1 : 0)
    expect(h.state().calls[0].authorization?.patch?.targets).toEqual([expect.objectContaining({ path, access: 'read', locator: ['operations', 0, 'path'] })])
    h.reopen(); if (mode === 'strict_approval') h.decide([{ type: 'approve' }])
    expect((await h.dispatch()).at(-1)?.content).toContain('"dryRun":true')
    expect(await pathExists(path)).toBe(false); expect(await h.fileEditStore.listEditRecordsForRequest(h.runId)).toEqual([])
  })

  it.each(['strict_approval', 'read_only_allowed', 'full_access'] as const)('previews external restoration as a read in %s', async mode => {
    const h = await fixture(), path = join(h.outside, 'created.txt'), args = await restoreArgs(h, [path]); h.mode(mode)
    await h.stage([{ id: 'restore-preview', name: 'restore_file_edit', args: { ...args, dry_run: true } }])
    expect(h.state().approvals).toHaveLength(mode === 'strict_approval' ? 1 : 0)
    expect(h.state().calls[0].authorization?.patch?.targets.every(target => target.access === 'read')).toBe(true)
    h.reopen(); if (mode === 'strict_approval') h.decide([{ type: 'approve' }])
    expect((await h.dispatch()).at(-1)?.content).toContain('"dryRun":true')
    expect(await readFile(path, 'utf8')).toBe('created\n'); expect(await h.fileEditStore.listEditRecordsForRequest(h.runId)).toEqual([])
  })

  it.each(['apply_patch', 'restore_file_edit'])('blocks an external %s preview when access tightens after preparation', async name => {
    const h = await fixture(), path = join(h.outside, 'preview.txt')
    const args = name === 'restore_file_edit' ? await restoreArgs(h, [path]) : { patch: `*** Begin Patch\n*** Add File: ${path}\n+created\n*** End Patch` }
    await h.stage([{ id: 'preview', name, args: { ...args, dry_run: true } }]); h.mode('strict_approval')
    const output = (await h.dispatch()).at(-1)!
    expect(output.resultStatus).toBe('error'); expect(output.content).toContain('Patch targets require a new approval after the access mode changed')
    expect(output.content).not.toContain('"dryRun":true')
    if (name === 'restore_file_edit') expect(await readFile(path, 'utf8')).toBe('created\n'); else expect(await pathExists(path)).toBe(false)
    expect(await h.fileEditStore.listEditRecordsForRequest(h.runId)).toEqual([])
  })

  it.each([['apply_patch', 'read_only_allowed'], ['apply_patch', 'strict_approval'], ['restore_file_edit', 'read_only_allowed'], ['restore_file_edit', 'strict_approval']] as const)(
    'does not convert full-access %s preparation into a human grant after switching to %s', async (name, mode) => {
    const h = await fixture(), path = join(h.outside, 'revoked.txt')
    const args = name === 'restore_file_edit' ? await restoreArgs(h, [path]) : { patch: `*** Begin Patch\n*** Add File: ${path}\n+created\n*** End Patch` }
    h.mode('full_access'); await h.stage([{ id: 'revoked-write', name, args }]); h.mode(mode)
    const output = (await h.dispatch()).at(-1)!
    expect(output.resultStatus).toBe('error'); expect(output.content).toContain('new approval')
    if (name === 'restore_file_edit') expect(await readFile(path, 'utf8')).toBe('created\n'); else expect(await pathExists(path)).toBe(false)
    expect(await h.fileEditStore.listEditRecordsForRequest(h.runId)).toEqual([])
  })

  it('preserves exact human approval after tightening access but requires a new decision for the next call', async () => {
    const h = await fixture(), firstPath = join(h.outside, 'first.txt'), nextPath = join(h.outside, 'next.txt')
    const create = (id: string, path: string) => ({ id, name: 'apply_patch', args: { patch: `*** Begin Patch\n*** Add File: ${path}\n+approved\n*** End Patch` } })
    await h.stage([create('first', firstPath)]); expect(h.state().calls[0].authorization?.patch?.humanApproved).toBe(false)
    h.mode('strict_approval'); h.reopen(); h.decide([{ type: 'approve' }]); await h.dispatch()
    expect(await readFile(firstPath, 'utf8')).toBe('approved\n')
    await h.stage([create('next', nextPath)])
    expect(h.state().approvals).toHaveLength(1); expect(h.state().calls[0].authorization?.patch?.humanApproved).toBe(false)
    expect(await pathExists(nextPath)).toBe(false)
    h.decide([{ type: 'reject' }]); await h.dispatch()
    expect(await pathExists(nextPath)).toBe(false); expect(await h.fileEditStore.listEditRecordsForRequest(h.runId)).toHaveLength(1)
  })

  it.each(['apply_patch', 'restore_file_edit'])('requires separate %s write approval after an approved preview', async name => {
    const h = await fixture(), path = join(h.outside, 'preview-then-write.txt')
    const args = name === 'restore_file_edit' ? await restoreArgs(h, [path]) : { patch: `*** Begin Patch\n*** Add File: ${path}\n+created\n*** End Patch` }
    h.mode('strict_approval'); await h.stage([{ id: 'preview', name, args: { ...args, dry_run: true } }])
    expect(h.state().approvals).toHaveLength(1)
    expect(h.state().calls[0].authorization?.patch?.targets).toEqual([expect.objectContaining({ path, access: 'read' })])
    h.decide([{ type: 'approve' }]); expect((await h.dispatch()).at(-1)?.content).toContain('"dryRun":true')
    const write = { id: 'write', name, args: { ...args, dry_run: false } }
    await h.stage([write]); expect(h.state().approvals).toHaveLength(1)
    expect(h.state().approvals[0].request.actionRequests).toMatchObject([{ name, args: write.args }])
    expect(h.state().calls[0].authorization?.patch?.targets).toEqual([expect.objectContaining({ path, access: 'write' })])
    if (name === 'restore_file_edit') expect(await readFile(path, 'utf8')).toBe('created\n'); else expect(await pathExists(path)).toBe(false)
    expect(await h.fileEditStore.listEditRecordsForRequest(h.runId)).toEqual([])
    h.reopen(); h.decide([{ type: 'approve' }]); expect((await h.dispatch()).at(-1)?.content).toContain('"ok":true')
    if (name === 'restore_file_edit') expect(await pathExists(path)).toBe(false); else expect(await readFile(path, 'utf8')).toBe('created\n')
    expect(await h.fileEditStore.listEditRecordsForRequest(h.runId)).toHaveLength(1)
  })
})
