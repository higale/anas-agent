import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage, AgentRunActivity } from '@shared/agentTypes'
import { AgentMessageList, AgentSubagentPanel, type EarlierActivityRequest } from './AgentMessageList'
import { AgentSubagentActivityTrigger } from './AgentSubagentActivityDock'
import { backgroundCleanupCompleted, backgroundCleanupStarted, backgroundTasksPendingError } from '@shared/backgroundCleanup'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { summary?: string; index?: number; seconds?: number }) => options?.seconds !== undefined
    ? `${key}: ${options.seconds}` : options?.index
    ? `${key} ${options.index}` : options?.summary
    ? `${key}: ${options.summary}`
    : key })
}))

const messages: AgentMessage[] = [{
  id: 'user-1',
  role: 'user',
  runId: 'run-1',
  content: [{ type: 'text', text: 'Run a tool' }]
}]

function activity(status: 'running' | 'completed'): AgentRunActivity {
  return {
    runId: 'run-1',
    operation: 'agent',
    status,
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:01.000Z',
    models: [],
    tools: [{
      call: { id: 'tool-1', name: 'probe', args: { query: 'test' } },
      sequence: 1,
      status,
      ...(status === 'completed' ? { output: 'ok' } : {})
    }],
    subagents: []
  }
}

describe('sleep countdown', () => {
  const props = { title: 'Thread', messages, panelRef: { current: null }, followOutputRef: { current: true },
    speech: { status: 'idle' as const }, onSpeak: vi.fn() }
  function sleeping(): AgentRunActivity {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-11T12:00:05Z'))
    const run = activity('running')
    run.tools[0] = { ...run.tools[0], startedAt: '2026-10-11T12:00:00Z',
      call: { id: 'sleep-call', name: 'sleep', args: { seconds: 15, summary: 'Wait for a reply' } } }
    return run
  }
  afterEach(() => vi.useRealTimers())

  it('counts from the recorded start and resumes correctly after leaving the conversation', () => {
    const run = sleeping()
    const view = render(<AgentMessageList {...props} activities={[run]} />)
    expect(screen.getByRole('timer')).toHaveTextContent('agent.sleep_remaining: 10')
    expect(view.container.querySelector('.agent-activity-tool > summary .lucide-clock')).not.toBeNull()
    expect(screen.getByRole('timer').closest('summary')).toHaveTextContent('Wait for a reply')
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByRole('timer')).toHaveTextContent('agent.sleep_remaining: 9')
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
    act(() => vi.advanceTimersByTime(3000))
    const reopened = render(<AgentMessageList {...props} activities={[run]} />)
    expect(screen.getByRole('timer')).toHaveTextContent('agent.sleep_remaining: 6')
    reopened.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for the actual result at zero, then shows the completed duration', () => {
    const run = sleeping()
    const view = render(<AgentMessageList {...props} activities={[run]} />)
    act(() => vi.advanceTimersByTime(10_000))
    expect(screen.getByRole('timer')).toHaveTextContent('agent.sleep_finishing')
    expect(view.container.querySelector('.agent-activity-result')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    const completed = { ...run, tools: [{ ...run.tools[0], status: 'completed' as const,
      completedAt: '2026-10-11T12:00:15Z', output: { status: 'completed', elapsed_seconds: 15 } }] }
    view.rerender(<AgentMessageList {...props} activities={[completed]} />)
    expect(screen.queryByRole('timer')).toBeNull()
    expect(view.container.querySelector('.agent-activity-tool > summary')).toHaveTextContent('15 s')
  })

  it.each(['cancelled', 'failed', 'completed'] as const)('stops on a %s run even if tool activity has not settled', (status) => {
    const run = sleeping()
    const view = render(<AgentMessageList {...props} activities={[run]} />)
    expect(screen.getByRole('timer')).toBeInTheDocument()
    view.rerender(<AgentMessageList {...props} activities={[{ ...run, status }]} />)
    expect(screen.queryByRole('timer')).toBeNull()
    act(() => vi.runOnlyPendingTimers())
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ends a cancelled subagent countdown while the parent keeps running', () => {
    const run = sleeping()
    run.tools[0].subagentId = 'child'
    run.subagents = [{ id: 'child', name: 'Child', sequence: 0, status: 'running' }]
    const view = render(<AgentSubagentPanel run={run} subagentId="child" />)
    expect(screen.getByRole('timer')).toHaveTextContent('agent.sleep_remaining: 10')
    view.rerender(<AgentSubagentPanel run={{ ...run, subagents: [{ ...run.subagents[0], status: 'cancelled' }] }} subagentId="child" />)
    expect(screen.queryByRole('timer')).toBeNull()
  })

  it.each(['arguments', 'timestamp', 'other-tool'] as const)('does not invent a countdown for invalid %s', (invalid) => {
    const run = sleeping()
    if (invalid === 'arguments') run.tools[0].call.args = { seconds: '15' }
    if (invalid === 'timestamp') run.tools[0].startedAt = 'invalid'
    if (invalid === 'other-tool') run.tools[0].call.name = 'other-tool'
    render(<AgentMessageList {...props} activities={[run]} />)
    expect(screen.queryByRole('timer')).toBeNull()
  })
})

describe('running tool shimmer', () => {
  const runningContent = '.agent-tool-running > summary'
  const props = { title: 'Thread', messages, panelRef: { current: null }, followOutputRef: { current: true },
    speech: { status: 'idle' as const }, onSpeak: vi.fn() }

  it.each(['read_file', 'pwsh', 'mcp__server__lookup', 'plugin__rdp__input', 'custom_probe', 'sleep'])(
    'animates the full summary row for %s, including when the argument summary is absent', (name) => {
      const run = activity('running')
      run.tools[0].call = { id: 'tool-1', name, args: { summary: 'Working on the request' } }
      const view = render(<AgentMessageList {...props} activities={[run]} />)
      expect(view.container.querySelectorAll(runningContent)).toHaveLength(1)
      expect(view.container.querySelector(runningContent)).toHaveTextContent(name)
      expect(view.container.querySelector(runningContent)).toHaveTextContent('Working on the request')
      expect(view.container.querySelector(runningContent)?.querySelector('.agent-activity-summary-icon')).not.toBeNull()
      expect(view.container.querySelector(runningContent)?.querySelector('.agent-activity-summary-status')).not.toBeNull()
      view.rerender(<AgentMessageList {...props} activities={[{ ...run, tools: [{ ...run.tools[0], call: { ...run.tools[0].call, args: {} } }] }]} />)
      expect(view.container.querySelectorAll(runningContent)).toHaveLength(1)
      expect(view.container.querySelector(runningContent)).toHaveTextContent(name)
    }
  )

  it.each(['completed', 'failed', 'cancelled', 'approval', 'user-input', 'tool-completed'] as const)(
    'stops the shimmer when execution changes to %s', (state) => {
      const run = activity('running')
      const view = render(<AgentMessageList {...props} activities={[run]} />)
      expect(view.container.querySelector(runningContent)).not.toBeNull()
      if (state === 'approval') run.tools[0].approval = { status: 'pending_approval', interruptId: 'approval', actionIndex: 0 }
      else if (state === 'user-input') run.tools[0].call.name = 'request_user_input'
      else if (state === 'tool-completed') run.tools[0].status = 'completed'
      else run.status = state
      view.rerender(<AgentMessageList {...props} activities={[{ ...run }]} />)
      expect(view.container.querySelector(runningContent)).toBeNull()
    }
  )

  it('does not animate tool names while arguments are still being received', () => {
    const run = activity('running')
    run.tools = []
    run.models = [{ id: 'model', sequence: 0, status: 'running', text: '', reasoning: '', toolCallIds: [],
      toolCallProgress: [{ index: 0, name: 'read_file', characterCount: 20, complete: false }] }]
    const view = render(<AgentMessageList {...props} activities={[run]} />)
    expect(view.container.querySelector('.agent-activity-tool')).toHaveTextContent('read_file')
    expect(view.container.querySelector(runningContent)).toBeNull()
  })
})

describe('AgentMessageList tool disclosure', () => {
  function expand(details: HTMLDetailsElement): void {
    fireEvent.click(details.querySelector('summary')!)
    fireEvent(details, new Event('toggle'))
  }

  it('labels native patch calls in the live timeline and reopened history', () => {
    const run = activity('running')
    run.tools[0].call = { id: 'tool-1', name: 'apply_patch', args: { input: '*** Begin Patch\n*** End Patch' } }
    const props = { title: 'Thread', messages, panelRef: { current: null }, followOutputRef: { current: true },
      speech: { status: 'idle' as const }, onSpeak: vi.fn() }
    const view = render(<AgentMessageList {...props} run={{ ...run, status: 'running', interrupts: [] }} activities={[]} />)
    const verifyLabel = () => {
      const label = screen.getByText('agent.tool_call_freeform')
      expect(label.closest('summary')).toHaveTextContent('apply_patch')
      expect(label).toHaveAttribute('data-tooltip', 'agent.tool_call_freeform_hint')
    }
    verifyLabel()
    view.unmount()
    render(<AgentMessageList {...props} activities={[{ ...run, status: 'completed',
      tools: [{ ...run.tools[0], status: 'completed', output: 'patched' }] }]} />)
    verifyLabel()
  })

  it.each([
    { name: 'apply_patch', args: { patch: 'patch text', dry_run: true } },
    { name: 'apply_patch', args: { input: 'patch text', summary: 'Extra JSON field' } },
    { name: 'apply_patch', args: { input: null } },
    { name: 'another_tool', args: { input: 'text' } }
  ])('does not label ordinary JSON calls as freeform: $name $args', (call) => {
    const run = activity('completed')
    run.tools[0].call = { id: 'tool-1', ...call }
    render(<AgentMessageList title="Thread" messages={messages} activities={[run]} panelRef={{ current: null }}
      followOutputRef={{ current: true }} speech={{ status: 'idle' }} onSpeak={vi.fn()} />)
    expect(screen.queryByText('agent.tool_call_freeform')).toBeNull()
  })

  it('shows the complete submitted Skill prompt during a run and after reopening history', () => {
    const promptText = '用户输入\n\n<skill>\n<name>summarize</name>\n<path>/skills/summarize/SKILL.md</path>\n---\nname: summarize\ndescription: Summarize documents.\n---\nRead references/style.md.\nLiteral text: $ARGUMENTS $0 <example>\n</skill>'
    const skillMessages: AgentMessage[] = [{ ...messages[0],
      content: [{ type: 'text', text: '/summarize 用户输入' }],
      skillInvocation: { name: 'summarize', args: '用户输入', promptText } }]
    const run = { ...activity('running'), tools: [] }
    const props = { title: 'Thread', messages: skillMessages, panelRef: { current: null },
      followOutputRef: { current: true }, speech: { status: 'idle' as const }, onSpeak: vi.fn() }
    const view = render(<AgentMessageList {...props} run={{ ...run, status: 'running', interrupts: [] }} activities={[]} />)
    const verifyPrompt = () => {
      const disclosure = document.querySelector<HTMLDetailsElement>('.agent-activity-skill-input')!
      if (!disclosure.open) expand(disclosure)
      expect(disclosure.querySelector('pre')?.textContent).toBe(promptText)
    }
    verifyPrompt()
    view.unmount()
    render(<AgentMessageList {...props} activities={[{ ...run, status: 'completed' }]} />)
    verifyPrompt()
  })

  it('previews tool images without expanding the result, including after reopening history', async () => {
    const run = activity('completed')
    const first = 'data:image/png;base64,AA=='
    const second = 'data:image/jpeg;base64,AQ=='
    run.tools[0].output = [{ type: 'image', mimeType: 'image/png', data: 'AA==' },
      { type: 'text', text: 'Captured twice' }, { type: 'image_url', image_url: { url: second } }]
    const props = { title: 'Thread', messages, panelRef: { current: null }, followOutputRef: { current: true },
      speech: { status: 'idle' as const }, onSpeak: vi.fn() }
    const view = render(<AgentMessageList {...props} run={{ ...run, status: 'running', interrupts: [] }} activities={[]} />)
    expand(view.container.querySelector<HTMLDetailsElement>('.agent-activity-tool')!)
    const result = view.container.querySelector<HTMLDetailsElement>('.agent-activity-result')!
    const images = () => screen.getAllByRole('button', { name: /^agent.view_tool_image/ })
    expect(images()).toHaveLength(2)
    fireEvent.click(images()[1])
    expect(result.open).toBe(false)
    expect(result.querySelector('pre')).toBeNull()
    expect(document.querySelector('.yarl__slide_current img')).toHaveAttribute('src', second)
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    await waitFor(() => expect(document.querySelector('.yarl__slide_current img')).toHaveAttribute('src', first))
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }))
    await waitFor(() => expect(document.querySelector('.yarl__root')).toBeNull())
    expect(result.open).toBe(false)
    expand(result)
    expect(result.querySelector('pre')).toHaveTextContent('Captured twice')
    view.unmount()
    render(<AgentMessageList {...props} activities={[run]} />)
    expand(document.querySelector<HTMLDetailsElement>('.agent-activity-tool')!)
    expect(images()).toHaveLength(2)
    fireEvent.click(images()[0])
    expect(document.querySelector('.yarl__slide_current img')).toHaveAttribute('src', first)
  })

  it.each(['', 'Original reasoning'])('shows a reply and collapsed cleanup through completion and reload (reasoning: %s)', (reasoning) => {
    const run = { ...activity('running'), status: 'running' as const, interrupts: [] }
    run.models = [{ id: 'model-1', messageId: 'assistant-1', sequence: 2, status: 'completed',
      text: 'PRESERVED_REPLY', reasoning, toolCallIds: [] }]
    run.tools = []
    const progress = `${backgroundTasksPendingError}\n${backgroundCleanupStarted}`
    const cleanup = { status: 'running' as const, report: progress }
    const props = { title: 'Thread', activities: [], panelRef: { current: null }, followOutputRef: { current: true },
      speech: { status: 'idle' as const }, onSpeak: vi.fn() }
    const checkpointMessages: AgentMessage[] = [...messages, {
      id: 'assistant-1', runId: run.runId, role: 'assistant',
      content: [{ type: 'text', text: 'PRESERVED_REPLY' }]
    }]
    const { rerender, unmount } = render(<AgentMessageList {...props} messages={messages} run={run} />)
    expect(screen.getAllByText('PRESERVED_REPLY')).toHaveLength(1)
    const disclosure = () => screen.getByText(/^agent.background_cleanup(?:_completed|_unconfirmed)?$/).closest('details')!
    const expectReportAfterReply = () => {
      const reply = screen.getByText('PRESERVED_REPLY')
      expect(reply.compareDocumentPosition(disclosure()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
    rerender(<AgentMessageList {...props} messages={checkpointMessages} run={{ ...run, backgroundCleanup: cleanup }} />)
    expectReportAfterReply()
    expect(disclosure().open).toBe(false)
    expect(disclosure().querySelector('pre')).toBeNull()
    const spinner = screen.getByRole('status', { name: 'agent.background_cleanup_started' })
    expect(disclosure().querySelector('summary')).toContainElement(spinner)
    expand(disclosure())
    expect(disclosure().querySelector('pre')).toHaveTextContent('agent.background_cleanup_started')
    const completed: AgentRunActivity = { ...run, status: 'completed',
      backgroundCleanup: { status: 'completed', report: `${progress}\n${backgroundCleanupCompleted}` } }
    rerender(<AgentMessageList {...props} messages={checkpointMessages} activities={[completed]} />)
    expect(screen.queryByRole('status', { name: 'agent.background_cleanup_started' })).toBeNull()
    expect(disclosure().open).toBe(true)
    expect(disclosure().querySelector('summary')).toHaveTextContent('agent.background_cleanup_completed')
    expect(disclosure().querySelector('pre')).toHaveTextContent('agent.background_cleanup_completed')
    expect(screen.getAllByText('PRESERVED_REPLY')).toHaveLength(1)
    expect(screen.queryByText('agent.run_failed')).toBeNull()
    expectReportAfterReply()
    unmount()
    render(<AgentMessageList {...props} messages={checkpointMessages} activities={[completed]} />)
    expect(disclosure().open).toBe(false)
    expect(disclosure().querySelector('pre')).toBeNull()
    expand(disclosure())
    expect(disclosure().querySelector('pre')).toHaveTextContent('agent.background_cleanup_completed')
    expectReportAfterReply()
  })

  it('shows unconfirmed cleanup honestly without labelling the run failed', () => {
    const run = { ...activity('completed'), backgroundCleanup: { status: 'unconfirmed' as const, report: 'Still stopping' } }
    render(<AgentMessageList title="Thread" messages={messages} activities={[run]} panelRef={{ current: null }}
      followOutputRef={{ current: true }} speech={{ status: 'idle' }} onSpeak={vi.fn()} />)
    expect(screen.getByText('agent.background_cleanup_unconfirmed')).toBeVisible()
    expect(screen.queryByText('agent.run_failed')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('marks counts as loaded while earlier activities remain and removes the qualifier after the last page', () => {
    const run = activity('completed')
    run.models = [{ id: 'model-1', messageId: 'assistant-1', sequence: 2, status: 'completed',
      text: 'FINAL_REPLY', reasoning: '', toolCallIds: [] }]
    run.activityWindow = { startSequence: 100, endSequence: 199, totalCount: 200, hasEarlier: true }
    const props = {
      title: 'Thread', messages: [...messages, {
        id: 'assistant-1', role: 'assistant' as const, runId: run.runId,
        content: [{ type: 'text' as const, text: 'FINAL_REPLY' }]
      }], panelRef: { current: null }, followOutputRef: { current: true },
      speech: { status: 'idle' as const }, onSpeak: vi.fn()
    }
    const { rerender } = render(<AgentMessageList {...props} activities={[run]} />)
    expect(screen.getByRole('button', { name: /agent.loaded_activity_summary: 1 model round · 1 tool call/ })).toBeVisible()

    rerender(<AgentMessageList {...props} activities={[{
      ...run, activityWindow: { startSequence: 0, endSequence: 1, totalCount: 2, hasEarlier: false }
    }]} />)
    expect(screen.getByRole('button', { name: /1 model round · 1 tool call/ })).toBeVisible()
    expect(screen.queryByText(/agent.loaded_activity_summary/)).toBeNull()
  })

  it('keeps rendered model rounds stable when an earlier page arrives and leaves drafts unnumbered', () => {
    const run = activity('running')
    run.models = [{ id: 'model-101', round: 101, sequence: 200, status: 'running',
      text: 'Current model', reasoning: '', toolCallIds: [] }]
    const props = { title: 'Thread', messages, panelRef: { current: null }, followOutputRef: { current: true },
      speech: { status: 'idle' as const }, onSpeak: vi.fn() }
    const { rerender } = render(<AgentMessageList {...props} activities={[run]} />)
    expect(screen.getByText('round 101')).toBeVisible()
    rerender(<AgentMessageList {...props} activities={[{ ...run, models: [
      { ...run.models[0], id: 'model-100', round: 100, sequence: 198, status: 'completed' },
      ...run.models,
      { ...run.models[0], id: 'draft', round: undefined, sequence: 202 }
    ] }]} />)
    expect(screen.getByText('round 100')).toBeVisible()
    expect(screen.getByText('round 101')).toBeVisible()
    expect(screen.getByText('round', { exact: true })).toBeVisible()
    expect(screen.queryByText('round 1', { exact: true })).toBeNull()
  })

  it('loads an earlier activity page for its run and aborts it when changing threads', async () => {
    const run = activity('running')
    run.activityWindow = { startSequence: 100, endSequence: 199, totalCount: 200, hasEarlier: true }
    let release!: () => void
    const load = vi.fn((_request: EarlierActivityRequest) => new Promise<void>((resolve) => { release = resolve }))
    const props = { title: 'Thread', messages, activities: [run], panelRef: { current: null }, followOutputRef: { current: true },
      speech: { status: 'idle' as const }, onSpeak: vi.fn(), onLoadEarlierActivities: load }
    const { rerender } = render(<AgentMessageList {...props} navigationKey="thread-1" />)
    const button = screen.getByRole('button', { name: 'agent.load_earlier_activities' })
    fireEvent.click(button)
    expect(button).toBeDisabled()
    expect(load).toHaveBeenCalledWith({ threadId: 'thread-1', runId: run.runId, signal: expect.any(AbortSignal) })
    const signal = load.mock.calls[0][0].signal
    rerender(<AgentMessageList {...props} navigationKey="thread-2" />)
    expect(signal.aborted).toBe(true)
    await act(async () => { release() })
    expect(screen.getByRole('button', { name: 'agent.load_earlier_activities' })).toBeEnabled()
  })

  it('requests deferred subagent details only when its panel opens and renders the completed result', async () => {
    const run = activity('completed')
    run.subagents = [{ id: 'child', name: 'Child', sequence: 2, status: 'completed', detailsDeferred: true }]
    let release!: () => void
    const load = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const { rerender } = render(<AgentSubagentPanel run={run} threadId="thread-1" subagentId="child" onLoadSubagentDetails={load} />)
    await waitFor(() => expect(load).toHaveBeenCalledWith('thread-1', run.runId, 'child'))
    expect(document.querySelector('.agent-subagent-result')).toBeNull()
    rerender(<AgentSubagentPanel run={{ ...run, subagents: [{ ...run.subagents[0], name: 'Updated child name' }] }}
      threadId="thread-1" subagentId="child" onLoadSubagentDetails={load} />)
    expect(load).toHaveBeenCalledTimes(1)
    await act(async () => { release() })
    rerender(<AgentSubagentPanel run={{ ...run, subagents: [{ ...run.subagents[0], detailsDeferred: false, result: 'FULL_CHILD_RESULT' }] }}
      threadId="thread-1" subagentId="child" onLoadSubagentDetails={load} />)
    expect(document.querySelector('.agent-subagent-result')).toHaveTextContent('FULL_CHILD_RESULT')
  })

  it.each([false, true])('only permits expansion after complete arguments arrive (late ID=%s)', (lateId) => {
    const props = {
      title: 'Thread', messages, panelRef: { current: null }, followOutputRef: { current: true },
      error: undefined, speech: { status: 'idle' as const }, onSpeak: vi.fn()
    }
    const run = activity('running')
    run.tools = []
    run.models = [{
      id: 'model-1', sequence: 0, status: 'running', text: '', reasoning: '', toolCallIds: [],
      toolCallProgress: [{ index: 2, callId: lateId ? undefined : 'tool-1', name: 'apply_patch', characterCount: 15, complete: false }]
    }]
    const view = render(<AgentMessageList {...props} activities={[run]} />)
    const card = view.container.querySelector<HTMLDetailsElement>('.agent-activity-tool')!
    const summary = card.querySelector('summary')!
    expect(summary).toHaveAttribute('aria-disabled', 'true')
    expect(card.textContent).toContain('agent.tool_arguments_generating')
    expect(screen.queryByText('agent.tool_call_freeform')).toBeNull()
    expand(card)
    for (const key of ['Enter', ' ']) {
      expect(fireEvent.keyDown(summary, { key })).toBe(false)
    }
    expect(card.open).toBe(false)
    expect(card.querySelector('pre')).toBeNull()
    expect(card.querySelector('.agent-activity-arguments')).toBeNull()
    const progress = run.models[0].toolCallProgress![0]
    progress.callId = 'tool-1'
    progress.characterCount = 100_000
    progress.complete = true
    view.rerender(<AgentMessageList {...props} activities={[{ ...run }]} />)
    expect(view.container.querySelector('.agent-activity-tool')).toBe(card)
    expect(summary).toHaveAttribute('aria-disabled', 'true')
    expect(card.querySelector('pre')).toBeNull()
    run.models[0].status = 'completed'
    run.models[0].toolCallIds = ['tool-1']
    run.tools = [{ call: { id: 'tool-1', name: 'apply_patch', args: { input: 'FULL_ARGUMENT_BODY' } }, sequence: 1, status: 'running' }]
    view.rerender(<AgentMessageList {...props} activities={[{ ...run }]} />)
    expect(view.container.querySelectorAll('.agent-activity-tool')).toHaveLength(1)
    expect(view.container.querySelector('.agent-activity-tool')).toBe(card)
    expect(summary).not.toHaveAttribute('aria-disabled')
    expect(summary).toHaveTextContent('agent.tool_call_freeform')
    expect(card.open).toBe(false)
    expect(card.querySelector('pre')).toBeNull()
    expand(card)
    const args = card.querySelector<HTMLDetailsElement>('.agent-activity-arguments')!
    expect(args.querySelector('pre')).toBeNull()
    expand(args)
    expect(args.querySelector('pre')).toHaveTextContent('FULL_ARGUMENT_BODY')
    run.tools[0] = { ...run.tools[0], status: 'completed', output: 'patched' }
    run.models[0].toolCallProgress = []
    view.rerender(<AgentMessageList {...props} activities={[{ ...run }]} />)
    expect(args.open).toBe(true)
    const result = card.querySelector<HTMLDetailsElement>('.agent-activity-result')!
    expect(result.querySelector('pre')).toBeNull()
    expand(result)
    expect(result.querySelector('pre')).toHaveTextContent('patched')
  })

  it('does not format hidden input or repeat formatting on status changes', () => {
    const serialize = vi.fn(() => ({ payload: 'LARGE_ARGUMENT' }))
    const run = activity('running')
    run.tools[0].call.args = { toJSON: serialize }
    const props = { title: 'Thread', messages, panelRef: { current: null }, followOutputRef: { current: true }, speech: { status: 'idle' as const }, onSpeak: vi.fn() }
    const view = render(<AgentMessageList {...props} activities={[run]} />)
    const card = view.container.querySelector<HTMLDetailsElement>('.agent-activity-tool')!
    expect(serialize).not.toHaveBeenCalled()
    expand(card)
    const args = card.querySelector<HTMLDetailsElement>('.agent-activity-arguments')!
    expect(serialize).not.toHaveBeenCalled()
    expand(args)
    expect(args.querySelector('pre')).toHaveTextContent('LARGE_ARGUMENT')
    expect(serialize).toHaveBeenCalledTimes(1)
    run.tools[0] = { ...run.tools[0], status: 'completed', output: 'done' }
    view.rerender(<AgentMessageList {...props} activities={[{ ...run }]} />)
    expect(serialize).toHaveBeenCalledTimes(1)
  })

  it('renders complete empty arguments when expanded', () => {
    const run = activity('completed')
    run.tools[0].call.args = {}
    const view = render(<AgentMessageList title="Thread" messages={[]} activities={[run]}
      panelRef={{ current: null }} followOutputRef={{ current: true }} speech={{ status: 'idle' }} onSpeak={vi.fn()} />)
    const card = view.container.querySelector<HTMLDetailsElement>('.agent-activity-tool')!
    expect(card.querySelector('pre')).toBeNull()
    expand(card)
    const args = card.querySelector<HTMLDetailsElement>('.agent-activity-arguments')!
    expand(args)
    expect(args.querySelector('pre')?.textContent).toBe('{}')
  })

  it('removes an interrupted argument reception without exposing partial input', () => {
    const run = activity('running')
    run.tools = []
    run.models = [{ id: 'model', sequence: 0, status: 'running', text: '', reasoning: '', toolCallIds: [],
      toolCallProgress: [{ index: 0, name: 'apply_patch', characterCount: 50, complete: false }] }]
    const props = { title: 'Thread', messages, panelRef: { current: null }, followOutputRef: { current: true }, speech: { status: 'idle' as const }, onSpeak: vi.fn() }
    const view = render(<AgentMessageList {...props} activities={[run]} />)
    expect(view.container.querySelector('summary[aria-disabled="true"]')).not.toBeNull()
    run.models[0].toolCallProgress = []
    view.rerender(<AgentMessageList {...props} activities={[{ ...run, status: 'failed' }]} />)
    expect(view.container.querySelector('.agent-activity-tool')).toBeNull()
  })

  it('shows start_subagent arguments and tool result in the subagent drawer', () => {
    const run = activity('completed')
    run.tools = [{
      call: {
        id: 'start-subagent',
        name: 'start_subagent',
        args: {
          description: 'DELEGATION_DESCRIPTION',
          agent: 'reviewer'
        }
      },
      sequence: 1,
      status: 'completed',
      output: JSON.stringify({ subagent_id: 'subagent-completed' })
    }]
    run.subagents = [{
      id: 'subagent-completed',
      name: 'reviewer',
      sequence: 2,
      status: 'completed',
      result: 'SUBAGENT_FINAL_RESULT'
    }]

    render(
      <AgentSubagentPanel
        run={run}
        subagentId="subagent-completed"
      />
    )

    expect(document.querySelector('.agent-activity-tool code'))
      .toHaveTextContent('start_subagent')
    expand(document.querySelector<HTMLDetailsElement>('.agent-activity-tool')!)
    expand(document.querySelector<HTMLDetailsElement>('.agent-activity-arguments')!)
    expand(document.querySelector<HTMLDetailsElement>('.agent-activity-result')!)
    expect(document.querySelector('.agent-activity-arguments'))
      .toHaveTextContent('DELEGATION_DESCRIPTION')
    expect(document.querySelector('.agent-activity-result'))
      .toHaveTextContent('subagent-completed')
    expect(document.querySelector('.agent-subagent-result'))
      .toHaveTextContent('SUBAGENT_FINAL_RESULT')
  })

  it('shows the durable subagent failure state and error in its drawer', () => {
    const run = activity('completed')
    run.subagents = [{
      id: 'subagent-failed',
      name: 'reviewer',
      sequence: 2,
      status: 'failed',
      error: 'SUBAGENT_FAILURE'
    }]

    render(
      <AgentSubagentPanel
        run={run}
        subagentId="subagent-failed"
      />
    )

    expect(screen.getByText(/Failed/)).toBeInTheDocument()
    expect(screen.getByText('SUBAGENT_FAILURE')).toBeInTheDocument()
    expect(document.querySelector('.agent-subagent-error')).not.toBeNull()
  })

  it('shows a recoverable subagent error without presenting the run as failed', () => {
    const run = activity('running')
    run.subagents = [{
      id: 'subagent-recovery-error',
      name: 'reviewer',
      sequence: 2,
      status: 'running',
      error: 'SUBAGENT_RECOVERY_FAILURE'
    }]

    render(
      <AgentSubagentPanel
        run={run}
        subagentId="subagent-recovery-error"
      />
    )

    expect(screen.getByText(/Recovery error/)).toBeInTheDocument()
    expect(screen.getByText('SUBAGENT_RECOVERY_FAILURE')).toBeInTheDocument()
    expect(screen.queryByText(/^Failed$/)).not.toBeInTheDocument()
  })

  it('shows recoverable subagent error details in the activity popover', async () => {
    const run = activity('running')
    run.subagents = [{
      id: 'subagent-recovery-error',
      name: 'reviewer',
      sequence: 2,
      status: 'running',
      error: 'SUBAGENT_RECOVERY_FAILURE'
    }]

    render(
      <AgentSubagentActivityTrigger
        run={run}
        subagentId="subagent-recovery-error"
        onOpenSubagent={vi.fn()}
      />
    )
    fireEvent.mouseEnter(screen.getByRole('button', { name: /Recovery error/ }))

    expect(await screen.findByText('SUBAGENT_RECOVERY_FAILURE')).toBeInTheDocument()
    expect(document.querySelector('.agent-subagent-activity-error')).not.toBeNull()
  })
})

describe('failed model request actions', () => {
  const props = { title: 'Thread', messages, panelRef: { current: null }, followOutputRef: { current: true },
    speech: { status: 'idle' as const }, onSpeak: vi.fn() }
  const failed = { ...activity('completed'), status: 'failed' as const, error: 'Provider rejected input' }
  const retry = { runId: 'run-1', revisionId: 'revision', canWithholdToolResults: true, requiresRollback: false }

  it('offers both actions below the current error and prevents duplicate clicks while submitting', async () => {
    let resolve!: () => void
    const onRetryModel = vi.fn(() => new Promise<void>(done => { resolve = done }))
    render(<AgentMessageList {...props} activities={[failed]} modelRetries={[retry]} onRetryModel={onRetryModel} />)
    const ordinary = screen.getByRole('button', { name: 'common.retry' })
    const withhold = screen.getByRole('button', { name: 'agent.retry_without_tool_results' })
    expect(ordinary.closest('[role="alert"]')).toHaveTextContent(failed.error)
    fireEvent.click(withhold)
    fireEvent.click(ordinary)
    expect(onRetryModel).toHaveBeenCalledExactlyOnceWith(retry, true)
    expect(ordinary).toBeDisabled()
    expect(withhold).toBeDisabled()
    await act(async () => resolve())
    fireEvent.click(ordinary)
    expect(onRetryModel).toHaveBeenLastCalledWith(retry, false)
    await act(async () => resolve())
  })

  it('shows only ordinary retry after user input and does not attach another run’s actions', () => {
    const onRetryModel = vi.fn(async () => {})
    const { rerender } = render(<AgentMessageList {...props} activities={[failed]}
      modelRetries={[{ ...retry, canWithholdToolResults: false }]} onRetryModel={onRetryModel} />)
    expect(screen.getByRole('button', { name: 'common.retry' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'agent.retry_without_tool_results' })).not.toBeInTheDocument()
    rerender(<AgentMessageList {...props} activities={[failed]} modelRetries={[{ ...retry, runId: 'another-run' }]} onRetryModel={onRetryModel} />)
    expect(screen.queryByRole('button', { name: 'common.retry' })).not.toBeInTheDocument()
  })
})


it('shows only the current recovery status and clears it when the run completes', () => {
  const run = activity('running'); run.tools = []
  run.models = [{ id: 'retry', sequence: 1, status: 'running', text: '', reasoning: '', toolCallIds: [],
    recovery: { attempts: 1, reason: 'invalid_tool_call', retryAt: Date.now() + 1000 } }]
  const props = { title: 'Thread', messages, panelRef: { current: null }, followOutputRef: { current: true },
    speech: { status: 'idle' as const }, onSpeak: vi.fn() }
  const view = render(<AgentMessageList {...props} activities={[run]} />)
  expect(screen.getByRole('status')).toHaveTextContent('agent.model_recovery_invalid_tool_call')
  view.rerender(<AgentMessageList {...props} activities={[{ ...run, status: 'completed' }]} />)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})
