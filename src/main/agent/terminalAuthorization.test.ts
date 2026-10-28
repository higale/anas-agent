import { nativeCapabilityFixture } from '../../test/nativeCapabilityFixture'
import { runtimeToolDefinitions } from '../llm/runtimeTools'
import { randomUUID } from 'node:crypto'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import type { ExecutionToolCall } from '../../runtime/executionState'
import type { RunObserver } from '../../runtime/runExecution'
import { ToolRunScope } from '../../runtime/toolEvents'
import { prepareConversationToolBatch, type ConversationToolPreparationOptions } from './conversationToolPreparation'
import { createConversationToolExecutor } from './conversationToolExecution'
import { describe, expect, it, vi } from 'vitest'
import type { AgentAccessMode } from '@shared/agentTypes'

describe('native terminal input authorization', () => {
  it.each(['approve', 'reject', 'ended'] as const)('handles %s without reusing command authorization or a stale terminal', async (decision) => {
    const h = nativeCapabilityFixture('pty-approval'), { database, service, thread, run } = h
    let finish!: (value: string) => void
    const completion = new Promise<string>((resolve) => { finish = resolve })
    const apply = vi.fn()
    const terminalId = '22222222-2222-4222-8222-222222222222'
    const starting = service.start({ kind: 'shell', threadId: thread.id, runId: run.id, summary: 'CLI',
      execute: async (control) => { control.markRunning(); control.setTerminal!({ id: terminalId, size: { columns: 100, rows: 30 }, apply }); return completion } })
    try {
      const callId = service.activeCallIds()[0]
      await vi.waitFor(() => expect(JSON.parse(service.read({ callId, threadId: thread.id }))).toHaveProperty('pty'))
      let accessMode: AgentAccessMode = 'full_access'
      const tools = await runtimeToolDefinitions({ enabled: true, primaryFolder: process.cwd(), shell: true, memory: false, network: false,
        mcp: false, backgroundTools: true, managedCalls: service, threadId: thread.id,
        commandShell: { executable: '/bin/zsh', name: 'zsh', family: 'posix' } })
      const write = tools.find((item) => item.name === 'write_call')!
      const call: ExecutionToolCall = { id: 'input', providerCallId: 'input', name: 'write_call', args: {
        call_id: callId, terminal_id: terminalId, action: { type: 'text', text: 'new command\r' }
      }, artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, randomUUID()])) as ExecutionToolCall['artifacts'] }
      const preparation: ConversationToolPreparationOptions = { runId: run.id, primaryFolder: process.cwd(), folders: [],
        accessMode: () => accessMode, includeRules: false, definitions: [write] }
      const owner = { threadId: thread.id, runId: run.id }, store = database.runs.store
      await database.runs.enter('input', owner)
      const scope = () => ({ ...owner, expectedRevisionId: store.load(thread.id)!.revisionId })
      store.acceptModel(scope(), { id: 'model', value: { kind: 'assistant', content: '', calls: [{ id: call.providerCallId, name: call.name, args: call.args }] } },
        [call], { modelCalls: 1, todos: [] })
      // The terminal and tool schema were created during full access. Revoking it
      // still governs this new input; the original command grants no exemption.
      accessMode = 'smart_approval'
      const prepared = await prepareConversationToolBatch(store.load(thread.id)!, preparation)
      if ('kind' in prepared) throw new Error('Unexpected context wait')
      store.prepareTools(scope(), prepared.calls, prepared.approvals, prepared.context)
      const paused = store.load(thread.id)!
      expect(paused.approvals).toHaveLength(1)
      expect(apply).not.toHaveBeenCalled()
      if (decision === 'ended') { finish('done'); await starting }
      const approval = paused.approvals[0]
      database.runs.saveAnswers(scope(), [{ id: approval.id, generation: approval.generation,
        response: { decisions: [{ type: decision === 'reject' ? 'reject' : 'approve' }] } }])
      await database.runs.enter('resume', owner)
      const operations = new ToolRunScope(), observer: RunObserver = { started: vi.fn(), startModel: vi.fn(() => 'model'), discardModel: vi.fn(),
        model: vi.fn(), tool: vi.fn(), approval: vi.fn(), committed: vi.fn(async () => {}) }
      const execute = createConversationToolExecutor({ store, definitions: [h.managed(write)], preparation, operations, planning: false,
        managed: database.execution.managed, persistFileChange: database.execution.persistFileChange })
      const resumed = store.load(thread.id)!
      const result = await execute(resumed.calls[0], resumed, { ...owner, signal: new AbortController().signal }, observer)
      expect(result.kind).toBe('result')
      await operations.drain()
      expect(apply).toHaveBeenCalledTimes(decision === 'approve' ? 1 : 0)
    } finally { finish('done'); await starting; await service.waitForIdle(); await h.close() }
  })
})
