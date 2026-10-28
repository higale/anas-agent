import { invokeCapability } from '../../runtime/toolInvocation'
import type { ToolDefinition } from '../../runtime/toolDefinition'
import { ToolInputError } from '../../runtime/errors'
import { defaultCapabilities, } from '@shared/agentCapabilities'
import { describe, expect, it, vi } from 'vitest'
import type { SubagentConfig } from '@shared/types'
import type { AgentSubagentCallRecord } from './subagentTaskStore'
import { subagentToolDefinitions, type SubagentProcessSnapshot, type SubagentToolRuntime } from './subagentTools'
import { runWithCurrentAgentToolEffect } from './toolEffectScope'

const requestApproval = vi.fn((_request: unknown): unknown => ({ decisions: [{ type: 'approve' }], __anas_interrupt_generation: 'generation-1' }))
async function invokeContent(tool: ToolDefinition | undefined, input: unknown): Promise<string> {
  if (!tool) throw new Error('Required subagent tool is missing')
  return String((await invokeCapability(tool, input, {})).content)
}

const reviewer: SubagentConfig = {
 capabilities: { ...structuredClone(defaultCapabilities), profile: false, workspace: true, memory: true, toolMode: 'all', tools: [], skills: { mode: 'default', project: false, entries: [] } },
  index: 0,
  name: 'reviewer',
  enabled: true,
  builtIn: false,
  description: 'Review changes.',
  systemPrompt: 'Review the delegated changes.',
}

function snapshot(overrides: Partial<AgentSubagentCallRecord> = {}): SubagentProcessSnapshot {
  return {
    call: {
      id: '11111111-1111-8111-8111-111111111111',
      ownerThreadId: 'owner',
      parentThreadId: 'parent',
      parentRunId: 'run',
      childThreadId: 'child',
      childRunId: 'child-run',
      agentName: 'reviewer',
      config: reviewer,
      description: 'Review the code.',
      status: 'running',
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
      ...overrides
    },
    modelRounds: 1,
    toolCalls: 2,
    activeTools: [],
    interrupts: [],
    approvalGeneration: 'generation-1'
  }
}

function runtime(current: SubagentProcessSnapshot): SubagentToolRuntime {
  return {
    start: vi.fn(async () => current),
    read: vi.fn(async () => current),
    wait: vi.fn(async () => current),
    cancel: vi.fn(async () => current),
    resume: vi.fn(async () => undefined),
    unresolvedForRun: vi.fn(() => []),
    resolveObserved: vi.fn(),
    cancelRun: vi.fn(async () => undefined)
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('subagent tools', () => {
  it('awaits the host approval service before resuming the same child generation', async () => {
    const pending = { ...snapshot({ status: 'interrupted' }), interrupts: [{ id: 'approval-native', approvalGeneration: 'generation-1',
      value: { actionRequests: [{ name: 'write_file', args: { path: 'result.txt' } }] } }] }
    const service = runtime(pending)
    service.wait = vi.fn().mockResolvedValueOnce(pending).mockResolvedValueOnce(snapshot({ status: 'completed' }))
    const gate = deferred<unknown>()
    const requestApproval = vi.fn(() => gate.promise)
    const wait = subagentToolDefinitions({ runtime: service, subagents: [reviewer], requestApproval })
      .find(tool => tool.name === 'wait_subagent')!
    const result = wait.execute({ subagent_id: pending.call.id }, {})
    await vi.waitFor(() => expect(requestApproval).toHaveBeenCalledOnce())
    expect(service.resume).not.toHaveBeenCalled()
    gate.resolve({ decisions: [{ type: 'approve' }], __anas_interrupt_generation: 'generation-1' })
    await expect(result).resolves.toMatchObject({ content: expect.stringContaining('"status":"completed"') })
    expect(service.resume).toHaveBeenCalledExactlyOnceWith(pending.call.id, [{
      interruptId: 'approval-native', decisions: [{ type: 'approve' }], expectedGeneration: 'generation-1'
    }])
  })

  it('exposes only the asynchronous subagent lifecycle', () => {
    expect(subagentToolDefinitions({ requestApproval,
      subagents: [reviewer]
    }).map((tool) => tool.name)).toEqual([
      'start_subagent',
      'read_subagent',
      'wait_subagent',
      'cancel_subagent'
    ])
  })

  it.each([true, false])('starts a selected subagent independently of global default enabled (%s)', async (enabled) => {
    const current = snapshot()
    const service = runtime(current)
    const start = subagentToolDefinitions({ requestApproval,
      runtime: service,
      subagents: [{ ...reviewer, enabled }]
    }).find((tool) => tool.name === 'start_subagent')!

    const result = JSON.parse(await invokeContent(start, {
      agent: 'reviewer',
      description: 'Review the code.'
    }) as string) as Record<string, unknown>

    expect(service.start).toHaveBeenCalledWith(
      { agentName: 'reviewer', config: { ...reviewer, enabled } },
      'Review the code.',
      expect.objectContaining({
        subagentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        childThreadId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        childRunId: expect.stringMatching(/^[0-9a-f-]{36}$/)
      }),
      expect.any(Function)
    )
    expect(result).toMatchObject({
      subagent_id: current.call.id,
      status: 'running',
      terminal: false,
      model_rounds: 1,
      tool_calls: 2
    })
  })

  it('lets the runtime arm start and cancel only after their pure validation', async () => {
    const service = runtime(snapshot())
    const tools = subagentToolDefinitions({ requestApproval,
      runtime: service,
      subagents: [reviewer]
    })
    const start = tools.find((tool) => tool.name === 'start_subagent')!
    const cancel = tools.find((tool) => tool.name === 'cancel_subagent')!
    const arm = vi.fn()

    await runWithCurrentAgentToolEffect({ arm }, () => invokeContent(start, {
      agent: 'reviewer',
      description: 'Review the code.'
    }))
    await runWithCurrentAgentToolEffect({ arm }, () => invokeContent(cancel, {
      subagent_id: '11111111-1111-8111-8111-111111111111'
    }))

    expect(arm).not.toHaveBeenCalled()
    expect(service.start).toHaveBeenCalledWith(
      { agentName: 'reviewer', config: reviewer },
      'Review the code.',
      expect.any(Object),
      expect.any(Function)
    )
    expect(service.cancel).toHaveBeenCalledWith(
      '11111111-1111-8111-8111-111111111111',
      expect.any(Function)
    )
    const startArm = vi.mocked(service.start).mock.calls[0][3]
    const cancelArm = vi.mocked(service.cancel).mock.calls[0][1]
    runWithCurrentAgentToolEffect({ arm }, startArm)
    runWithCurrentAgentToolEffect({ arm }, cancelArm)
    expect(arm).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: 'subagent-start',
      recoveryMode: 'idempotent'
    }))
    expect(arm).toHaveBeenNthCalledWith(2, {
      kind: 'subagent-cancel',
      target: { subagentId: '11111111-1111-8111-8111-111111111111' },
      recoveryMode: 'idempotent'
    })
  })

  it('keeps a durable start replay reachable without a currently configured agent', async () => {
    const service = runtime(snapshot())
    const tools = subagentToolDefinitions({ requestApproval,
      runtime: service,
      subagents: [],
      includeStartForRecovery: true
    })
    expect(tools.map((tool) => tool.name)).toEqual([
      'start_subagent',
      'read_subagent',
      'wait_subagent',
      'cancel_subagent'
    ])
    await invokeContent(tools.find((tool) => tool.name === 'start_subagent'), {
      agent: 'reviewer',
      description: 'Resume the durable launch.'
    })
    expect(service.start).toHaveBeenCalledWith(
      { agentName: 'reviewer' },
      'Resume the durable launch.',
      expect.any(Object),
      expect.any(Function)
    )
  })

  it('allows only one wait and approval lifecycle per subagent at a time', async () => {
    const waitingForApproval = {
      ...snapshot({ status: 'interrupted' }),
      interrupts: [{
        id: 'approval-1',
        approvalGeneration: 'generation-1',
        value: { actionRequests: [{ name: 'apply_patch', args: { path: 'result.txt' } }] }
      }]
    }
    const completed = snapshot({ status: 'completed', result: 'Reviewed.' })
    const resumeGate = deferred<void>()
    const service = runtime(waitingForApproval)
    service.wait = vi.fn()
      .mockResolvedValueOnce(waitingForApproval)
      .mockResolvedValueOnce(completed)
      .mockResolvedValueOnce(completed)
    service.resume = vi.fn(() => resumeGate.promise)
    const wait = subagentToolDefinitions({ requestApproval,
      runtime: service,
      subagents: [reviewer]
    }).find((tool) => tool.name === 'wait_subagent')!
    const input = {
      subagent_id: '11111111-1111-8111-8111-111111111111',
      timeout: 10
    }

    const first = invokeContent(wait, input)
    await vi.waitFor(() => expect(service.resume).toHaveBeenCalledOnce())

    await expect(invokeContent(wait, input)).rejects.toBeInstanceOf(ToolInputError)
    await expect(invokeContent(wait, input)).rejects.toThrow('already has an active wait')
    expect(service.wait).toHaveBeenCalledOnce()
    expect(requestApproval).toHaveBeenCalledOnce()

    resumeGate.resolve()
    await expect(first).resolves.toContain('"status":"completed"')
    expect(service.wait).toHaveBeenCalledTimes(2)
    expect(service.resume).toHaveBeenCalledOnce()

    await expect(invokeContent(wait, input)).resolves.toContain('"status":"completed"')
    expect(service.wait).toHaveBeenCalledTimes(3)
  })

  it('presents parallel child approvals together and resumes them atomically', async () => {
    const waitingForApproval = {
      ...snapshot({ status: 'interrupted' }),
      interrupts: [{
        id: 'approval-1',
        approvalGeneration: 'generation-1',
        value: {
          actionRequests: [{ name: 'apply_patch', args: { path: 'first.txt' } }],
          reviewConfigs: [{ actionName: 'apply_patch', allowedDecisions: ['approve', 'reject'] }]
        }
      }, {
        id: 'approval-2',
        approvalGeneration: 'generation-1',
        value: {
          actionRequests: [{ name: 'pwsh', args: { command: 'npm test' } }],
          reviewConfigs: [{ actionName: 'pwsh', allowedDecisions: ['approve', 'reject'] }]
        }
      }]
    }
    const completed = snapshot({ status: 'completed', result: 'Done.' })
    const service = runtime(waitingForApproval)
    service.wait = vi.fn()
      .mockResolvedValueOnce(waitingForApproval)
      .mockResolvedValueOnce(completed)
    requestApproval.mockReturnValueOnce({
      decisions: [{ type: 'approve' }, { type: 'reject', message: 'Skip command.' }],
      __anas_interrupt_generation: 'generation-1'
    } as never)
    const wait = subagentToolDefinitions({ requestApproval,
      runtime: service,
      subagents: [reviewer]
    }).find((tool) => tool.name === 'wait_subagent')!

    await expect(invokeContent(wait, {
      subagent_id: '11111111-1111-8111-8111-111111111111',
      timeout: 10
    })).resolves.toContain('"status":"completed"')

    expect(requestApproval).toHaveBeenCalledOnce()
    expect(requestApproval).toHaveBeenCalledWith({
      actionRequests: [
        { name: 'apply_patch', args: { path: 'first.txt' } },
        { name: 'pwsh', args: { command: 'npm test' } }
      ],
      reviewConfigs: [
        { actionName: 'apply_patch', allowedDecisions: ['approve', 'reject'] },
        { actionName: 'pwsh', allowedDecisions: ['approve', 'reject'] }
      ],
      anasSubagentApproval: { generation: 'generation-1' }
    }, { subagentId: waitingForApproval.call.id, callId: undefined })
    expect(service.resume).toHaveBeenCalledOnce()
    expect(service.resume).toHaveBeenCalledWith(
      '11111111-1111-8111-8111-111111111111',
      [{
        interruptId: 'approval-1',
        decisions: [{ type: 'approve' }],
        expectedGeneration: 'generation-1'
      }, {
        interruptId: 'approval-2',
        decisions: [{ type: 'reject', message: 'Skip command.' }],
        expectedGeneration: 'generation-1'
      }]
    )
  })

  it('never applies a stale approval response to a later subagent interrupt generation', async () => {
    const waitingForApproval = {
      ...snapshot({ status: 'interrupted' }),
      approvalGeneration: 'generation-2',
      interrupts: [{
        id: 'approval-2',
        approvalGeneration: 'generation-2',
        value: { actionRequests: [{ name: 'apply_patch', args: { path: 'second.txt' } }] }
      }]
    }
    const completed = snapshot({ status: 'completed', result: 'Done.' })
    const service = runtime(waitingForApproval)
    service.wait = vi.fn()
      .mockResolvedValueOnce(waitingForApproval)
      .mockResolvedValueOnce(completed)
    requestApproval
      .mockReturnValueOnce({
        decisions: [{ type: 'approve' }],
        __anas_interrupt_generation: 'generation-1'
      } as never)
      .mockReturnValueOnce({
        decisions: [{ type: 'reject', message: 'Review the new request.' }],
        __anas_interrupt_generation: 'generation-2'
      } as never)
    const wait = subagentToolDefinitions({ requestApproval,
      runtime: service,
      subagents: [reviewer]
    }).find((tool) => tool.name === 'wait_subagent')!

    await expect(invokeContent(wait, {
      subagent_id: waitingForApproval.call.id,
      timeout: 10
    })).resolves.toContain('"status":"completed"')

    expect(requestApproval).toHaveBeenCalledTimes(2)
    expect(service.resume).toHaveBeenCalledWith(waitingForApproval.call.id, [{
      interruptId: 'approval-2',
      decisions: [{ type: 'reject', message: 'Review the new request.' }],
      expectedGeneration: 'generation-2'
    }])
  })
})
