import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage, AgentRunActivity } from '@shared/agentTypes'
import { AgentMessageList as MessageList, AgentSubagentPanel as SubagentPanel } from './AgentMessageList'
import type { ComponentProps } from 'react'
import { ActivityPreferences } from './ActivityPreferences'
import { AgentSubagentActivityTrigger } from './AgentSubagentActivityDock'
import { PanelViewState } from './PanelViewState'
import * as contentServiceModule from '../panels/contentServices'
import { backgroundCleanupCompleted, backgroundCleanupStarted, backgroundTasksPendingError } from '@shared/backgroundCleanup'
import { activityAtomsFromItems, ActivityGroupBuilder, isProcessAtom } from '@shared/activityView'
import { projectRunActivityItems } from '@shared/agentTimeline'
import type { ActivityDirectoryInput } from '@shared/activityDirectory'
import { notice } from '../notice'

// Existing disclosure cases exercise the collapsed preference explicitly.
const AgentMessageList = (props: ComponentProps<typeof MessageList>) => <ActivityPreferences value={{ runningProcessDisplay: 'collapsed', showModelRounds: true }}><MessageList {...props} /></ActivityPreferences>
const AgentSubagentPanel = (props: ComponentProps<typeof SubagentPanel>) => <ActivityPreferences value={{ runningProcessDisplay: 'collapsed', showModelRounds: true }}><SubagentPanel {...props} /></ActivityPreferences>

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { resolvedLanguage: 'en' }, t: (key: string, options?: { summary?: string; index?: number; seconds?: number; duration?: string }) => options?.duration
    ? `${key}: ${options.duration}` : options?.seconds !== undefined
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

function expand(details: HTMLDetailsElement): void {
  fireEvent.click(details.querySelector('summary')!)
  fireEvent(details, new Event('toggle'))
}

describe('process display preferences', () => {
  it('ticks from the run start without new activity, includes waiting, freezes on completion, and releases its timer', () => {
    vi.useFakeTimers()
    const start = Date.parse('2026-11-06T00:00:00Z')
    vi.setSystemTime(start)
    const run = { ...activity('running'), createdAt: new Date(start).toISOString(), updatedAt: new Date(start).toISOString() }
    const content = () => <MessageList title="Thread" messages={messages} activities={[{ ...run }]} panelRef={{ current: null }}
      followOutputRef={{ current: true }} speech={{ status: 'idle' }} onSpeak={vi.fn()} />
    const view = render(content())
    const elapsed = () => view.container.querySelector('.agent-run-elapsed')
    try {
      expect(elapsed()).toHaveTextContent('agent.run_elapsed_active: 0s')
      act(() => vi.advanceTimersByTime(3000))
      expect(elapsed()).toHaveTextContent('agent.run_elapsed_active: 3s')
      view.rerender(<MessageList title="Thread" messages={messages} activities={[{ ...run, status: 'interrupted' }]} panelRef={{ current: null }}
        followOutputRef={{ current: true }} speech={{ status: 'idle' }} onSpeak={vi.fn()} />)
      act(() => vi.advanceTimersByTime(2000))
      expect(elapsed()).toHaveTextContent('agent.run_elapsed_active: 5s')
      expect(view.container.querySelector('.agent-activity-range-status')).toHaveTextContent('agent.run_waiting_for_approval')
      vi.setSystemTime(start + 24000)
      act(() => vi.advanceTimersByTime(1000))
      expect(elapsed()).toHaveTextContent('agent.run_elapsed_active: 25s')
      run.status = 'completed'; run.updatedAt = new Date(start + 25000).toISOString()
      view.rerender(content())
      act(() => vi.advanceTimersByTime(5000))
      expect(elapsed()).toHaveTextContent('agent.run_elapsed: 25s')
      view.unmount()
      expect(vi.getTimerCount()).toBe(0)
      run.status = 'running'
      const reopened = render(content())
      expect(reopened.container.querySelector('.agent-run-elapsed')).toHaveTextContent('agent.run_elapsed_active: 30s')
      reopened.unmount()
      expect(vi.getTimerCount()).toBe(0)
    } finally { view.unmount(); vi.useRealTimers() }
  })
  it.each([
    ['expanded', false], ['collapsed', false], ['expanded', true], ['collapsed', true]
  ] as const)('closes preceding process groups at the first reply, preserving later manual choices (%s, child=%s)', (mode, child) => {
    const run = activity('running'), subagentId = child ? 'child' : undefined
    if (child) run.subagents = [{ id: 'child', name: 'Child', sequence: 0, status: 'running' }]
    run.tools[0].subagentId = subagentId
    run.models = [{ id: 'reasoner', subagentId, sequence: 0, round: 1, status: 'running', text: '', reasoning: 'Thinking', toolCallIds: ['tool-1'] }]
    const content = () => <ActivityPreferences value={{ runningProcessDisplay: mode, showModelRounds: true }}>
      {child ? <SubagentPanel run={{ ...run }} subagentId="child" /> : <MessageList title="Thread" messages={messages} activities={[{ ...run }]}
        panelRef={{ current: null }} followOutputRef={{ current: true }} speech={{ status: 'idle' }} onSpeak={vi.fn()} />}
    </ActivityPreferences>
    const view = render(content())
    const groups = () => [...view.container.querySelectorAll<HTMLDetailsElement>('.agent-activity-process')]
    expect(groups()[0].open).toBe(mode === 'expanded')
    if (!groups()[0].open) expand(groups()[0])
    run.models.push({ id: 'reply', subagentId, sequence: 2, round: 2, status: 'running', text: 'First reply', reasoning: '', toolCallIds: [] })
    view.rerender(content())
    expect(run.status).toBe('running')
    expect(groups()[0].open).toBe(false)
    expect(view.container.querySelector('.agent-timeline-member')).toBeNull()
    expand(groups()[0])
    run.models[1] = { ...run.models[1], text: 'First reply continues' }
    view.rerender(content())
    expect(groups()[0].open).toBe(true)
    run.models.push({ id: 'next', subagentId, sequence: 3, round: 3, status: 'running', text: '', reasoning: 'Next thought', toolCallIds: [] })
    view.rerender(content())
    expect(groups()).toHaveLength(2)
    expect(groups()[1].open).toBe(mode === 'expanded')
    if (!groups()[1].open) expand(groups()[1])
    run.models[2] = { ...run.models[2], text: 'Next reply' }
    view.rerender(content())
    expect(groups()[0].open).toBe(true)
    expect(groups()[1].open).toBe(false)
    run.status = 'completed'
    if (child) run.subagents[0].status = 'completed'
    view.rerender(content())
    expect(groups()[0].open).toBe(true)
    expect(groups()[1].open).toBe(false)
  })
  it('also closes an expanded standalone tool when the following reply appears', () => {
    const run = activity('running')
    const content = () => <MessageList title="Thread" messages={messages} activities={[{ ...run }]} panelRef={{ current: null }}
      followOutputRef={{ current: true }} speech={{ status: 'idle' }} onSpeak={vi.fn()} />
    const view = render(content())
    const tool = () => view.container.querySelector<HTMLDetailsElement>('.agent-activity-tool')!
    expand(tool()); expect(tool().open).toBe(true)
    run.models = [{ id: 'reply', sequence: 2, status: 'completed', text: 'Reply', reasoning: '', toolCallIds: [] }]
    view.rerender(content())
    // The reply closes the process even while the enclosing run remains active.
    const group = view.container.querySelector<HTMLDetailsElement>('.agent-activity-process')!
    expect(group.open).toBe(false)
    expand(group)
    expect(tool().open).toBe(false)
    expand(tool()); view.rerender(content())
    expect(tool().open).toBe(true)
  })
  it('uses total run elapsed time for the outer fold regardless of member durations', () => {
    const run = activity('completed')
    run.updatedAt = '2026-08-19T00:01:40.000Z'
    run.tools[0] = { ...run.tools[0], startedAt: run.createdAt, completedAt: '2026-08-19T00:00:02.000Z' }
    const view = render(<MessageList title="Thread" messages={messages} activities={[run]} panelRef={{ current: null }}
      followOutputRef={{ current: true }} speech={{ status: 'idle' }} onSpeak={vi.fn()} />)
    expect(view.container.querySelector('.agent-activity-range-toggle[aria-expanded]')).toHaveTextContent('agent.run_elapsed: 1m 40s')
  })
  it.each(['expanded', 'collapsed'] as const)('uses %s during execution, collapses on finish, and retains later manual choices', mode => {
    const running = activity('running')
    running.models = [{ id: 'reasoner', sequence: 0, round: 1, status: 'running', text: '', reasoning: 'Thinking', toolCallIds: ['tool-1'] }]
    const completed: AgentRunActivity = { ...running, status: 'completed', tools: running.tools.map(tool => ({ ...tool, status: 'completed' })),
      models: [{ ...running.models[0], status: 'completed' }, { id: 'final-model', messageId: 'final', sequence: 2, round: 2,
        status: 'completed', text: 'Finished', reasoning: '', toolCallIds: [] }] }
    const props = { title: 'Thread', panelRef: { current: null }, followOutputRef: { current: true }, speech: { status: 'idle' as const }, onSpeak: vi.fn() }
    const content = (run: AgentRunActivity) => <ActivityPreferences value={{ runningProcessDisplay: mode, showModelRounds: true }}>
      <MessageList {...props} activities={[run]} messages={run.status === 'running' ? messages : [...messages,
        { id: 'final', activityModelId: 'final-model', runId: run.runId, role: 'assistant', content: [{ type: 'text', text: 'Finished' }] }]} />
    </ActivityPreferences>
    const view = render(content(running))
    const group = () => view.container.querySelector<HTMLDetailsElement>('.agent-activity-process')!
    expect(group().open).toBe(mode === 'expanded')
    const toggle = () => { fireEvent.click(group().querySelector('summary')!); fireEvent(group(), new Event('toggle')) }
    if (!group().open) toggle()
    view.rerender(content(completed))
    const outer = view.container.querySelector<HTMLButtonElement>('.agent-activity-range-toggle[aria-expanded]')!
    expect(outer).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(outer)
    expect(group().open).toBe(false)
    expect(group().querySelector('summary')).toHaveTextContent('agent.process_thought_tools')
    toggle(); expect(group().open).toBe(true)
    view.rerender(content({ ...completed }))
    expect(group().open).toBe(true)
    view.rerender(content(running))
    expect(group().open).toBe(mode === 'expanded')
    view.rerender(content(completed))
    expect(view.container.querySelector('.agent-activity-range-toggle[aria-expanded]')).toHaveAttribute('aria-expanded', 'false')
  })
  it('hides round metadata while retaining recovery status and the original reasoning label', () => {
    const run = activity('running'); run.tools = []
    run.models = [{ id: 'reasoner', sequence: 0, round: 9, status: 'running', text: '', reasoning: 'Thinking', toolCallIds: [],
      recovery: { reason: 'invalid_tool_call', attempts: 1, retryAt: Date.now() + 1000 } }]
    const view = render(<ActivityPreferences value={{ runningProcessDisplay: 'expanded', showModelRounds: false }}>
      <MessageList title="Thread" messages={messages} activities={[run]} panelRef={{ current: null }} followOutputRef={{ current: true }}
        speech={{ status: 'idle' }} onSpeak={vi.fn()} />
    </ActivityPreferences>)
    expect(screen.queryByText('round 9')).toBeNull()
    expect(screen.getAllByRole('status')).toHaveLength(1)
    expect(view.container.querySelectorAll('.agent-spin')).toHaveLength(1)
    expect(view.container.querySelector('.agent-activity-model > header')).toBeNull()
    expect(view.container.querySelector('.agent-activity-reasoning > summary')).toHaveTextContent('reasoning')
  })
  it.each([false, true])('hides empty groups after a reply or scope completion, retaining live waiting and recovery (child=%s)', child => {
    const run = activity('running'), subagentId = child ? 'child' : undefined
    run.tools = []
    if (child) run.subagents = [{ id: 'child', name: 'Child', sequence: 0, status: 'running' }]
    run.models = [{ id: 'model', subagentId, sequence: 1, round: 1, status: 'running', text: '', reasoning: '', toolCallIds: [] }]
    const content = () => <ActivityPreferences value={{ runningProcessDisplay: 'expanded', showModelRounds: false }}>
      {child ? <SubagentPanel run={{ ...run }} subagentId="child" /> : <MessageList title="Thread" messages={messages} activities={[{ ...run }]}
        panelRef={{ current: null }} followOutputRef={{ current: true }} speech={{ status: 'idle' }} onSpeak={vi.fn()} />}
    </ActivityPreferences>
    const view = render(content())
    expect(view.container.querySelector('.agent-activity-process > summary')).toHaveTextContent('agent.process_waiting')
    expect(view.container.querySelectorAll('.virtual-timeline .agent-spin')).toHaveLength(1)
    expect(view.container.querySelector('.agent-timeline-member')).toBeNull()
    run.models[0].recovery = { reason: 'invalid_tool_call', attempts: 1, retryAt: Date.now() + 1000 }
    view.rerender(content())
    expect(view.container.querySelector('.agent-activity-process > summary')).toHaveTextContent('agent.model_recovery_invalid_tool_call')
    delete run.models[0].recovery
    run.models[0].text = 'Visible reply'
    view.rerender(content())
    expect(screen.getByText('Visible reply')).toBeInTheDocument()
    expect(view.container.querySelector('.agent-activity-process')).toBeNull()
    expect(view.container.querySelector('.agent-activity-model')).toBeNull()
    run.models[0].text = ''
    if (child) run.subagents[0].status = 'completed'
    else run.status = 'completed'
    view.rerender(content())
    expect(view.container.querySelector('.agent-activity-process')).toBeNull()
  })
  it('filters empty directory groups before reading members, preserves thought/tool content, and restores rounds on preference changes', async () => {
    const fixture = activity('completed')
    fixture.tools[0].sequence = 4
    fixture.models = [
      { id: 'reply', sequence: 1, round: 1, status: 'completed', text: 'Visible reply', reasoning: '', toolCallIds: [] },
      { id: 'empty', sequence: 2, round: 2, status: 'completed', text: '', reasoning: '', toolCallIds: ['tool-1'] },
      { id: 'thought', sequence: 3, round: 3, status: 'completed', text: '', reasoning: '', hasReasoning: true,
        toolCallIds: [], detail: { threadId: 'thread', runId: fixture.runId, kind: 'model', id: 'thought' } }
    ]
    const atoms = activityAtomsFromItems(projectRunActivityItems(fixture, new Map(), []))
    const builder = new ActivityGroupBuilder()
    const outline = [...atoms.flatMap(atom => builder.push(atom)), ...builder.finish()]
    const directory = vi.fn(async (input: ActivityDirectoryInput) => {
      const group = outline.find(node => node.type === 'process' && node.key === input.parentId)
      const items = group ? atoms.filter(atom => isProcessAtom(atom) && atom.position.sequence >= group.start.sequence && atom.position.sequence <= group.end.sequence)
        .map(atom => ({ ...atom, key: atom.position.key, start: atom.position, end: atom.position })) : outline
      return { version: '1', items, removed: [] }
    })
    const detail = vi.fn().mockResolvedValue({ reasoning: 'Deferred thought' })
    const service = vi.spyOn(contentServiceModule, 'contentServices').mockReturnValue({ agent: {
      activities: { directory, detail, cancel: vi.fn(async () => {}) },
      onEvent: (_listener: unknown, synchronize: () => Promise<void>) => { void synchronize(); return vi.fn() }
    } } as unknown as ReturnType<typeof contentServiceModule.contentServices>)
    const run = { ...fixture, models: [], tools: [], display: { modelCount: 3, toolCount: 1, subagentCount: 0 } }
    const content = (showModelRounds: boolean) => <ActivityPreferences value={{ runningProcessDisplay: 'expanded', showModelRounds }}>
      <MessageList title="Thread" navigationKey="thread" messages={messages} activities={[run]}
        panelRef={{ current: null }} followOutputRef={{ current: true }} speech={{ status: 'idle' }} onSpeak={vi.fn()} />
    </ActivityPreferences>
    const view = render(content(false))
    try {
      await screen.findByText('Visible reply')
      const groups = () => [...view.container.querySelectorAll<HTMLDetailsElement>('.agent-activity-process')]
      expect(groups()).toHaveLength(1)
      expect(groups()[0].querySelector('summary')).toHaveTextContent('agent.process_thought_tools')
      expect(directory).toHaveBeenCalledTimes(1)
      expand(groups()[0])
      await waitFor(() => expect(view.container.querySelector('.agent-activity-reasoning')).not.toBeNull())
      expect(directory).toHaveBeenCalledTimes(2)
      expect(detail).not.toHaveBeenCalled()
      expect(view.container.querySelectorAll('.agent-timeline-member')).toHaveLength(2)
      expect(view.container.querySelectorAll('.agent-activity-model')).toHaveLength(1)
      expect(view.container.querySelector('.agent-activity-tool')).not.toBeNull()
      expand(view.container.querySelector<HTMLDetailsElement>('.agent-activity-reasoning')!)
      await screen.findByText('Deferred thought')
      view.rerender(content(true))
      expect(groups()).toHaveLength(2)
      expect(screen.getByText('round 2')).toBeInTheDocument()
      expand(groups()[0])
      await screen.findByText('round 1')
      view.rerender(content(false))
      expect(groups()).toHaveLength(1)
      expect(screen.queryByText(/^round /)).toBeNull()
      expect(view.container.querySelectorAll('.agent-timeline-member')).toHaveLength(2)
      expect(screen.getByText('Visible reply')).toBeInTheDocument()
    } finally { view.unmount(); service.mockRestore() }
  })
})

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
    // Deliver the native details toggle task before checking the countdown's timer cleanup.
    act(() => vi.advanceTimersByTime(0))
    reopened.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for the actual result at zero, then shows the completed duration', () => {
    const run = sleeping()
    const view = render(<AgentMessageList {...props} activities={[run]} />)
    act(() => vi.advanceTimersByTime(10_000))
    expect(screen.getByRole('timer')).toHaveTextContent('agent.sleep_finishing')
    expect(view.container.querySelector('.agent-activity-result')).toBeNull()
    expect(vi.getTimerCount()).toBe(1) // The run elapsed clock continues while awaiting the tool result.
    const completed = { ...run, tools: [{ ...run.tools[0], status: 'completed' as const,
      completedAt: '2026-10-11T12:00:15Z', output: { status: 'completed', elapsed_seconds: 15 } }] }
    view.rerender(<AgentMessageList {...props} activities={[completed]} />)
    expect(screen.queryByRole('timer')).toBeNull()
    expect(view.container.querySelector('.agent-activity-tool > summary')).toHaveTextContent('15 s')
    expect(view.container.querySelector('.agent-activity-tool > summary .lucide-activity')).toBeVisible()
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
    expect(view.container.querySelector('.agent-activity-process > summary')).toHaveTextContent('read_file')
    expect(view.container.querySelector(runningContent)).toBeNull()
  })
})

describe('AgentMessageList tool disclosure', () => {
  function members(group: Element) {
    const key = group.closest<HTMLElement>('[data-timeline-row]')!.dataset.timelineRow
    const rows = () => [...group.ownerDocument.querySelectorAll<HTMLElement>('[data-timeline-parent]')].filter(row => row.dataset.timelineParent === key)
    return {
      querySelector: <T extends Element = Element>(selector: string): T | null => rows().map(row => row.querySelector<T>(selector)).find(Boolean) ?? null,
      querySelectorAll: <T extends Element = Element>(selector: string): T[] => rows().flatMap(row => [...row.querySelectorAll<T>(selector)])
    }
  }
  function retainedList(run: AgentRunActivity) {
    return <PanelViewState><AgentMessageList title="Thread" messages={messages} activities={[run]}
      panelRef={{ current: null }} followOutputRef={{ current: true }} speech={{ status: 'idle' }} onSpeak={vi.fn()} /></PanelViewState>
  }

  it.each(['approval', 'input'] as const)('preserves inspected details and the stable process after %s is resolved', (kind) => {
    const run = activity('running')
    const tool = run.tools[0]
    const call = kind === 'input' ? { ...tool.call, name: 'request_user_input' } : tool.call
    run.models = [{ id: 'm', status: 'completed', sequence: 0, text: '', reasoning: 'Earlier reasoning', toolCallIds: [call.id] }]
    const waiting = { ...run, tools: [{ ...tool, call, approval: kind === 'approval'
      ? { status: 'pending_approval' as const, interruptId: 'i', actionIndex: 0 } : undefined }] }
    const resumed = { ...run, tools: [{ ...tool, call, status: kind === 'input' ? 'completed' as const : tool.status }] }
    for (const inspecting of [false, true]) {
      const view = render(retainedList(waiting))
      const card = view.container.querySelector<HTMLDetailsElement>('.agent-activity-tool')!
      if (inspecting) {
        expand(card)
        expand(card.querySelector<HTMLDetailsElement>('.agent-activity-arguments')!)
      }
      const body = card.querySelector('pre')
      view.rerender(retainedList(resumed))
      if (inspecting) {
        expect(view.container.querySelector('.agent-activity-arguments pre')).toBe(body)
        expect(body).toHaveTextContent('test')
        expect(view.container.querySelector('.agent-activity-model')).toBeVisible()
        expand(view.container.querySelector<HTMLDetailsElement>('.agent-activity-process')!)
      }
      expect(view.container.querySelector('.agent-activity-tool')).toBeNull()
      expect(view.container.querySelectorAll('.agent-activity-process')).toHaveLength(1)
      view.unmount()
    }
  })

  it.each([false, true])('preserves the inspected tool when a second tool arrives (inspecting=%s)', (inspecting) => {
    const run = activity('running')
    const view = render(retainedList(run))
    const first = view.container.querySelector<HTMLDetailsElement>('.agent-activity-tool')!
    if (inspecting) {
      expand(first)
      expand(first.querySelector<HTMLDetailsElement>('.agent-activity-arguments')!)
    }
    const body = first.querySelector('pre')
    view.rerender(retainedList({ ...run, tools: [...run.tools, { ...run.tools[0], sequence: 2,
      call: { id: 'tool-2', name: 'second', args: {} } }] }))
    const group = view.container.querySelector<HTMLDetailsElement>('.agent-activity-process')!
    expect(group.open).toBe(inspecting)
    if (!inspecting) expand(group)
    const cards = members(group).querySelectorAll<HTMLDetailsElement>('.agent-activity-tool')
    expect(cards[0].open).toBe(inspecting)
    expect(cards[1].open).toBe(false)
    if (inspecting) {
      expect(cards[0].querySelector('pre')).toBe(body)
      expect(body).toHaveTextContent('test')
    }
  })

  it('keeps the following tool mounted and exposes pending approval on the stable group header', () => {
    const run = activity('running')
    const first = run.tools[0]
    run.tools = [first, { ...first, sequence: 2, call: { ...first.call, id: 'later' } }]
    const view = render(retainedList(run))
    const group = view.container.querySelector<HTMLDetailsElement>('.agent-activity-process')!
    expand(group)
    const later = members(group).querySelectorAll<HTMLDetailsElement>('.agent-activity-tool')[1]
    expand(later)
    expand(later.querySelector<HTMLDetailsElement>('.agent-activity-arguments')!)
    const body = later.querySelector('pre')
    expect(body).toHaveTextContent('test')
    view.rerender(retainedList({ ...run, tools: [{ ...first,
      approval: { status: 'pending_approval', interruptId: 'i', actionIndex: 0 } }, run.tools[1]] }))
    expect(members(group).querySelector('.agent-activity-arguments pre')).toBe(body)
    expand(group)
    expect(group.querySelector('summary .lucide-shield-alert')).toBeVisible()
    expand(group)
    expect(view.container.querySelector('.agent-activity-tool > summary .lucide-shield-alert')).toBeVisible()
  })

  it('collapses reasoning completed while its group was closed and remembers a subsequent manual expansion', () => {
    const run = activity('running')
    run.models = [{ id: 'model', sequence: 0, status: 'running', text: '', reasoning: 'Reasoning body', toolCallIds: [] }]
    const view = render(retainedList(run))
    const group = view.container.querySelector<HTMLDetailsElement>('.agent-activity-process')!
    expand(group)
    expect(members(group).querySelector('pre')).toHaveTextContent('Reasoning body')
    expand(group)
    view.rerender(retainedList({ ...run, models: [{ ...run.models[0], status: 'completed' }] }))
    expand(group)
    const reasoning = members(group).querySelector<HTMLDetailsElement>('.agent-activity-reasoning')!
    expect(reasoning.open).toBe(false)
    expect(members(group).querySelector('pre')).toBeNull()
    expand(reasoning)
    expand(group)
    expand(group)
    expect(members(group).querySelector('pre')).toHaveTextContent('Reasoning body')
  })

  it.each([false, true])('unmounts closed reasoning and reopens the latest text (retained panel=%s)', (retained) => {
    const run = activity('running')
    run.models = [{ id: 'model', sequence: 0, status: 'running', text: '', reasoning: 'Initial reasoning', toolCallIds: [] }]
    const state = new Map<string, unknown>()
    const content = () => {
      const list = <AgentMessageList title="Thread" messages={messages} activities={[{ ...run }]}
        panelRef={{ current: null }} followOutputRef={{ current: true }} speech={{ status: 'idle' }} onSpeak={vi.fn()} />
      return retained ? <PanelViewState state={state}>{list}</PanelViewState> : list
    }
    const view = render(content())
    const group = view.container.querySelector<HTMLDetailsElement>('.agent-activity-process')!
    expect(group.open).toBe(false)
    expect(members(group).querySelector('.agent-activity-reasoning')).toBeNull()
    expand(group)
    const details = members(group).querySelector<HTMLDetailsElement>('.agent-activity-reasoning')!
    expect(details.querySelector('pre')).toHaveTextContent('Initial reasoning')
    expand(details)
    expect(details.open).toBe(false)
    expect(details.querySelector('pre')).toBeNull()
    run.models[0] = { ...run.models[0], reasoning: 'Initial reasoning followed by streamed text' }
    view.rerender(content())
    expect(details.querySelector('pre')).toBeNull()
    expand(details)
    expect(details.querySelector('pre')).toHaveTextContent('Initial reasoning followed by streamed text')
    run.models[0] = { ...run.models[0], status: 'completed' }
    view.rerender(content())
    expect(details.open).toBe(false)
    expect(details.querySelector('pre')).toBeNull()
    expand(details)
    view.rerender(content())
    expect(details.querySelector('pre')).toHaveTextContent('Initial reasoning followed by streamed text')
    expand(group)
    expect(members(group).querySelector('.agent-activity-reasoning')).toBeNull()
    expect(members(group).querySelector('.agent-activity-tool')).toBeNull()
  })

  it('reads only the selected process detail and unsubscribes when the whole group closes', async () => {
    const run = activity('completed')
    const tool = run.tools[0]
    tool.detail = { threadId: 'thread', runId: run.runId, kind: 'tool', id: tool.call.id }
    delete tool.output
    run.models = [{ id: 'm', sequence: 0, status: 'completed', text: '', reasoning: '', hasReasoning: true,
      toolCallIds: [tool.call.id], detail: { ...tool.detail, kind: 'model', id: 'm' } }]
    const stop = vi.fn(), detail = vi.fn().mockResolvedValue({ args: {}, output: 'Tool output' })
    const service = vi.spyOn(contentServiceModule, 'contentServices').mockReturnValue({ agent: { activities: { detail },
      onEvent: (_listener: unknown, synchronize: () => Promise<void>) => { void synchronize(); return stop }
    } } as unknown as ReturnType<typeof contentServiceModule.contentServices>)
    try {
      const view = render(<AgentMessageList title="Thread" messages={messages} activities={[run]}
        panelRef={{ current: null }} followOutputRef={{ current: true }} speech={{ status: 'idle' }} onSpeak={vi.fn()} />)
      const group = view.container.querySelector<HTMLDetailsElement>('.agent-activity-process')!
      expand(group)
      expect(detail).not.toHaveBeenCalled()
      expand(members(group).querySelector<HTMLDetailsElement>('.agent-activity-tool')!)
      await waitFor(() => expect(members(group).querySelector('.agent-activity-result')).not.toBeNull())
      expect(detail.mock.calls).toEqual([[{ ...tool.detail, field: undefined }]])
      expand(group)
      expect(stop).toHaveBeenCalledOnce()
      expect(members(group).querySelector('.agent-activity-tool')).toBeNull()
    } finally { service.mockRestore() }
  })

  it('unmounts summary Markdown on completion and reads updated content on reopening', () => {
    const run = activity('running')
    run.summaries = [{ id: 'summary', sequence: 2, status: 'running', summaryText: '**SUMMARY_BODY**', createdAt: run.createdAt }]
    const content = () => <AgentMessageList title="Thread" messages={messages} activities={[{ ...run }]}
      panelRef={{ current: null }} followOutputRef={{ current: true }} speech={{ status: 'idle' }} onSpeak={vi.fn()} />
    const view = render(content())
    const details = view.container.querySelector<HTMLDetailsElement>('.agent-context-summary')!
    expect(details.querySelector('strong')).toHaveTextContent('SUMMARY_BODY')
    run.summaries[0] = { ...run.summaries[0], status: 'completed' }
    view.rerender(content())
    expect(details.open).toBe(false)
    expect(details.querySelector('strong')).toBeNull()
    run.summaries[0] = { ...run.summaries[0], summaryText: '**UPDATED_SUMMARY**' }
    view.rerender(content())
    expand(details)
    expect(details.querySelector('strong')).toHaveTextContent('UPDATED_SUMMARY')
    expand(details)
    expect(details.querySelector('strong')).toBeNull()
  })

  it('releases nested tool bodies and restores their expansion choices when the tool reopens', () => {
    const run = activity('completed')
    const serialize = vi.fn(() => ({ body: 'TOOL_BODY' }))
    run.tools[0].output = { toJSON: serialize }
    const view = render(<PanelViewState><AgentMessageList title="Thread" messages={messages} activities={[run]}
      panelRef={{ current: null }} followOutputRef={{ current: true }} speech={{ status: 'idle' }} onSpeak={vi.fn()} /></PanelViewState>)
    const card = view.container.querySelector<HTMLDetailsElement>('.agent-activity-tool')!
    expand(card)
    expand(card.querySelector<HTMLDetailsElement>('.agent-activity-result')!)
    expect(card.querySelector('pre')).toHaveTextContent('TOOL_BODY')
    expect(serialize).toHaveBeenCalledTimes(1)
    expand(card)
    expect(card.querySelector('.agent-activity-result')).toBeNull()
    expect(card.querySelector('pre')).toBeNull()
    expand(card)
    expect(card.querySelector('pre')).toHaveTextContent('TOOL_BODY')
    expect(serialize).toHaveBeenCalledTimes(2)
  })

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

  it.each([false, true])('previews tool images without expanding the result, including after reopening history (deferred=%s)', async deferred => {
    const run = activity('completed')
    const first = 'data:image/png;base64,AA=='
    const second = 'data:image/jpeg;base64,AQ=='
    run.tools[0].output = [{ type: 'image', mimeType: 'image/png', data: 'AA==' },
      { type: 'text', text: 'Captured twice' }, { type: 'image_url', image_url: { url: second } }]
    const payload = { args: { query: 'Full tool arguments' }, output: run.tools[0].output }
    const detail = vi.fn().mockResolvedValue(payload)
    if (deferred) {
      run.tools[0].detail = { threadId: 'thread', runId: run.runId, kind: 'tool', id: run.tools[0].call.id }
      delete run.tools[0].output
      vi.spyOn(contentServiceModule, 'contentServices').mockReturnValue({ agent: {
        activities: { detail },
        onEvent: (_listener: unknown, synchronize: () => Promise<void>) => { void synchronize(); return () => undefined }
      } } as unknown as ReturnType<typeof contentServiceModule.contentServices>)
    }
    const props = { title: 'Thread', messages, panelRef: { current: null }, followOutputRef: { current: true },
      speech: { status: 'idle' as const }, onSpeak: vi.fn() }
    const view = render(<AgentMessageList {...props} run={{ ...run, status: 'running', interrupts: [] }} activities={[]} />)
    expect(detail).not.toHaveBeenCalled()
    expand(view.container.querySelector<HTMLDetailsElement>('.agent-activity-tool')!)
    await screen.findAllByRole('button', { name: /^agent.view_tool_image/ })
    const result = view.container.querySelector<HTMLDetailsElement>('.agent-activity-result')!
    const images = () => screen.getAllByRole('button', { name: /^agent.view_tool_image/ })
    expect(images()).toHaveLength(2)
    expect(images().every(button => button.closest('summary') === result.querySelector('summary'))).toBe(true)
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
    if (deferred) {
      const args = view.container.querySelector<HTMLDetailsElement>('.agent-activity-arguments')!
      expand(args)
      expect(args.querySelector('pre')).toHaveTextContent('Full tool arguments')
      expand(args)
      expand(args)
      expand(result)
      expect(images()).toHaveLength(2)
      expect(detail).toHaveBeenCalledTimes(1)
      expect(detail).toHaveBeenLastCalledWith({ ...run.tools[0].detail, field: undefined })
      const tool = view.container.querySelector<HTMLDetailsElement>('.agent-activity-tool')!
      expand(tool)
      expect(tool.querySelector('pre')).toBeNull()
      expect(screen.queryAllByRole('button', { name: /^agent.view_tool_image/ })).toHaveLength(0)
      detail.mockResolvedValue({ ...payload, args: { query: 'Updated tool arguments' } })
      expand(tool)
      await screen.findAllByRole('button', { name: /^agent.view_tool_image/ })
      expand(view.container.querySelector<HTMLDetailsElement>('.agent-activity-arguments')!)
      expect(tool.querySelector('pre')).toHaveTextContent('Updated tool arguments')
      expect(detail).toHaveBeenCalledTimes(2)
    }
    view.unmount()
    render(<AgentMessageList {...props} activities={[run]} />)
    expand(document.querySelector<HTMLDetailsElement>('.agent-activity-tool')!)
    await screen.findAllByRole('button', { name: /^agent.view_tool_image/ })
    expect(images()).toHaveLength(2)
    if (deferred) expect(detail).toHaveBeenCalledTimes(3)
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

  it('uses run elapsed time independently of the number of loaded activities', () => {
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
    expect(screen.getByRole('button', { name: 'agent.run_elapsed: 1s' })).toBeVisible()

    rerender(<AgentMessageList {...props} activities={[{
      ...run, activityWindow: { startSequence: 0, endSequence: 1, totalCount: 2, hasEarlier: false }
    }]} />)
    expect(screen.getByRole('button', { name: 'agent.run_elapsed: 1s' })).toBeVisible()
    expect(screen.queryByText(/agent.loaded_activity_summary/)).toBeNull()
  })

  it('keeps rendered model rounds stable when an earlier page arrives and leaves drafts unnumbered', () => {
    const run = activity('running')
    run.tools = []
    run.models = [{ id: 'model-101', round: 101, sequence: 200, status: 'running',
      text: 'Current model', reasoning: '', toolCallIds: [] }]
    const props = { title: 'Thread', messages, panelRef: { current: null }, followOutputRef: { current: true },
      speech: { status: 'idle' as const }, onSpeak: vi.fn() }
    const { rerender, container } = render(<AgentMessageList {...props} activities={[run]} />)
    expand(container.querySelector<HTMLDetailsElement>('.agent-activity-process')!)
    expect(screen.getByText('round 101')).toBeVisible()
    rerender(<AgentMessageList {...props} activities={[{ ...run, models: [
      { ...run.models[0], id: 'model-100', round: 100, sequence: 198, status: 'completed' },
      ...run.models,
      { ...run.models[0], id: 'draft', round: undefined, sequence: 202 }
    ] }]} />)
    container.querySelectorAll<HTMLDetailsElement>('.agent-activity-process:not([open])').forEach(expand)
    expect(screen.getByText('round 100')).toBeVisible()
    expect(screen.getByText('round 101')).toBeVisible()
    expect(screen.getByText('round', { exact: true })).toBeVisible()
    expect(screen.queryByText('round 1', { exact: true })).toBeNull()
  })

  it('collapses all intervening rounds between two visible replies and restores their headers in order', () => {
    const run = activity('completed')
    const model = { id: 'm1', round: 1, sequence: 0, status: 'completed' as const,
      startedAt: '2026-11-04T12:00:00.000Z', completedAt: '2026-11-04T12:00:01.900Z',
      reasoning: '', text: 'First reply', toolCallIds: ['tool-1'] }
    run.models = [model, { ...model, id: 'm2', round: 2, sequence: 2, text: '', toolCallIds: ['sleep'] },
      { ...model, id: 'm3', round: 3, sequence: 4, reasoning: 'Reasoning detail', text: 'Next reply', toolCallIds: [] }]
    run.tools.push({ ...run.tools[0], sequence: 3, call: { id: 'sleep', name: 'sleep', args: { seconds: 1 } } })
    const view = render(<AgentMessageList title="Thread" messages={messages} activities={[run]}
      panelRef={{ current: null }} followOutputRef={{ current: true }} speech={{ status: 'idle' }} onSpeak={vi.fn()} />)
    const timeline = view.container.querySelector('.virtual-timeline')!
    expect([...timeline.querySelectorAll('[data-activity-item]')].map(row => row.textContent)).toEqual(['agent.process_model', 'First reply', 'agent.process_thought_tools', 'Next reply'])
    const group = timeline.querySelectorAll<HTMLDetailsElement>('.agent-activity-process')[1]
    expand(group)
    const headers = members(group).querySelectorAll('.agent-activity-model > header')
    expect([...headers].map(header => header.textContent)).toEqual(['round 2· 1.9 s', 'round 3· 1.9 s'])
    expect([...headers].every(header => header.closest('[data-timeline-parent]')?.getAttribute('data-timeline-parent') === group.closest('[data-timeline-row]')?.getAttribute('data-timeline-row'))).toBe(true)
    expect(members(group).querySelector('pre')).toBeNull()
    expand(group)
    expect(members(group).querySelector('.agent-activity-model')).toBeNull()
  })

  it('splits adjacent process steps at visible model replies and user guidance', () => {
    const run = activity('completed')
    const model = { id: 'm', status: 'completed' as const, sequence: 0, round: 1,
      startedAt: '2026-11-04T12:00:00.000Z', completedAt: '2026-11-04T12:00:01.900Z', reasoning: 'Hidden reasoning', text: 'Progress update', toolCallIds: [] }
    run.models = [model, { ...model, id: 'm2', round: 2, text: '', sequence: 3 }]
    run.tools.push({ ...run.tools[0], sequence: 2, call: { ...run.tools[0].call, id: 't2' } },
      { ...run.tools[0], sequence: 4, call: { ...run.tools[0].call, id: 't3' } })
    const direction = { ...messages[0], id: 'direction', directionAfterToolCallIds: ['t2'], content: [{ type: 'text' as const, text: 'Please stop editing' }] }
    const view = render(<AgentMessageList title="Thread" messages={[...messages, direction]} activities={[run]}
      panelRef={{ current: null }} followOutputRef={{ current: true }} speech={{ status: 'idle' }} onSpeak={vi.fn()} />)
    const rows = view.container.querySelectorAll('[data-activity-item]')
    expect([...rows].map(row => row.textContent)).toEqual(['agent.process_thought', 'Progress update',
      'agent.process_tools', 'Please stop editing', 'agent.process_thought_tools'])
    const firstProcess = rows[0].querySelector<HTMLDetailsElement>('details')!
    expand(firstProcess)
    const header = screen.getByText('round 1').closest('header')!
    const reasoning = members(firstProcess).querySelector<HTMLDetailsElement>('.agent-activity-reasoning')!
    expect(header.closest('[data-timeline-parent]')).toHaveAttribute('data-timeline-parent', firstProcess.closest('[data-timeline-row]')!.getAttribute('data-timeline-row')!)
    expect(header).toHaveTextContent('1.9 s')
    expect(reasoning.querySelector('summary')).toHaveTextContent('reasoning')
    expect(reasoning.open).toBe(false)
    expect(reasoning.querySelector('pre')).toBeNull()
    expand(reasoning)
    expect(reasoning.querySelector('pre')).toHaveTextContent('Hidden reasoning')
    expect(reasoning).not.toContainElement(header)
    expect(view.container.querySelector('.agent-activity-tool')).toBeNull()
  })

  it('updates the collapsed icon from the current step, including reasoning after a previous tool', () => {
    const run = activity('running')
    const props = { title: 'Thread', messages, panelRef: { current: null }, followOutputRef: { current: true },
      speech: { status: 'idle' as const }, onSpeak: vi.fn() }
    run.models = [{ id: 'm1', round: 1, sequence: 0, status: 'running', text: '', reasoning: '', toolCallIds: [] }]
    const tool = { ...run.tools[0], call: { ...run.tools[0].call, name: 'pwsh', args: { summary: 'Inspect the workspace' } } }
    run.tools = []
    const view = render(<AgentMessageList {...props} activities={[run]} />)
    const header = view.container.querySelector('.agent-activity-process > summary')!
    const icon = (name: string) => header.querySelector(`.agent-activity-summary-icon .lucide-${name}`)
    const update = () => view.rerender(<AgentMessageList {...props} activities={[{ ...run }]} />)
    expect(icon('clock')).toBeVisible()
    run.models[0] = { ...run.models[0], status: 'completed', toolCallIds: [tool.call.id] }
    run.tools = [tool]
    update()
    expect(icon('terminal')).toBeVisible()
    expect(header).toHaveTextContent('pwsh')
    expect(header).toHaveTextContent('Inspect the workspace')
    expect(header).not.toHaveTextContent('agent.tool_call')
    run.tools = [{ ...tool, status: 'completed' }]
    run.models.push({ ...run.models[0], id: 'm2', round: 2, sequence: 2, status: 'running', reasoning: 'Thinking', reasoningSummary: 'Consider next action', toolCallIds: [] })
    update()
    expect(icon('brain')).toBeVisible()
    expect(header).toHaveTextContent('reasoning')
    expect(header).toHaveTextContent('Consider next action')
    expect(header).not.toHaveTextContent('Inspect the workspace')
    run.status = 'completed'
    update()
    expect(icon('activity')).toBeVisible()
    expand(header.closest('details')!)
    expect(view.container.querySelector('.agent-activity-tool > summary .lucide-terminal')).toBeVisible()
    expect(view.container.querySelector('.agent-activity-tool > summary')).toHaveTextContent('Inspect the workspace')
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
    expand(view.container.querySelector<HTMLDetailsElement>('.agent-activity-process')!)
    const card = view.container.querySelector<HTMLDetailsElement>('.agent-activity-tool')!
    const summary = card.querySelector('summary')!
    expect(summary).toHaveAttribute('aria-disabled', 'true')
    expect(card.textContent).toContain('agent.tool_arguments_generating')
    expect(view.container.querySelector('.agent-activity-process > summary')).toHaveTextContent('agent.tool_arguments_generating')
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

  it.each([
    ['{"ok":true,"exitCode":0,"stdout":"bl 2.3.0\\n","stderr":"warning\\n"}',
      '{\n  "ok": true,\n  "exitCode": 0,\n  "stdout": "bl 2.3.0\\n",\n  "stderr": "warning\\n"\n}'],
    [' \n[{"id":9007199254740993,"id":1.2300e+40,"text":"{,} [\\"x\\"] \\u4e2d"},[],{},null,true,-0]\t',
      '[\n  {\n    "id": 9007199254740993,\n    "id": 1.2300e+40,\n    "text": "{,} [\\"x\\"] \\u4e2d"\n  },\n  [],\n  {},\n  null,\n  true,\n  -0\n]']
  ])('formats complete JSON strings in arguments and results without changing values: %s', (source, formatted) => {
    const run = activity('completed')
    run.tools[0].call.args = source
    run.tools[0].output = source
    const view = render(<AgentMessageList title="Thread" messages={[]} activities={[run]}
      panelRef={{ current: null }} followOutputRef={{ current: true }} speech={{ status: 'idle' }} onSpeak={vi.fn()} />)
    const card = view.container.querySelector<HTMLDetailsElement>('.agent-activity-tool')!
    expand(card)
    for (const selector of ['.agent-activity-arguments', '.agent-activity-result']) {
      const section = card.querySelector<HTMLDetailsElement>(selector)!
      expect(section.querySelector('pre')).toBeNull()
      expand(section)
      expect(section.querySelector('pre')?.textContent).toBe(formatted)
      expand(section)
      expect(section.querySelector('pre')).toBeNull()
    }
    expect(run.tools[0].call.args).toBe(source)
    expect(run.tools[0].output).toBe(source)
  })

  it.each(['log: {"ok":true}\n', '{"ok":true}\nnext line', '{"ok":', '[1,]', '{"ok": true, /* comment */}',
    '123', 'true', 'null', '"text"', '  plain text\n', '{}', '[]'])('preserves non-structured text or empty JSON: %s', output => {
    const run = activity('completed')
    run.tools[0].output = output
    const view = render(<AgentMessageList title="Thread" messages={[]} activities={[run]}
      panelRef={{ current: null }} followOutputRef={{ current: true }} speech={{ status: 'idle' }} onSpeak={vi.fn()} />)
    const card = view.container.querySelector<HTMLDetailsElement>('.agent-activity-tool')!
    expand(card)
    const result = card.querySelector<HTMLDetailsElement>('.agent-activity-result')!
    expand(result)
    expect(result.querySelector('pre')?.textContent).toBe(output)
  })

  describe('activity copy actions', () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const writeText = vi.fn<(text: string) => Promise<void>>()
    beforeEach(() => {
      writeText.mockReset().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
      vi.spyOn(notice, 'success').mockReturnValue(1)
      vi.spyOn(notice, 'error').mockReturnValue(1)
    })
    afterEach(() => {
      if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
      else Reflect.deleteProperty(navigator, 'clipboard')
    })
    function tool(output: unknown) {
      const run = activity('completed')
      run.tools[0].output = output
      const view = render(<AgentMessageList title="Thread" messages={[]} activities={[run]}
        panelRef={{ current: null }} followOutputRef={{ current: true }} speech={{ status: 'idle' }} onSpeak={vi.fn()} />)
      const card = view.container.querySelector<HTMLDetailsElement>('.agent-activity-tool')!
      expand(card)
      return card
    }
    it('copies the latest streamed reasoning verbatim and releases the copy action when collapsed', async () => {
      const run = activity('running')
      run.tools = []
      run.models = [{ id: 'model', sequence: 0, status: 'running', text: '', reasoning: ' {"plan":"first"}\n', toolCallIds: [] }]
      const content = () => <AgentMessageList title="Thread" messages={messages} activities={[{ ...run }]}
        panelRef={{ current: null }} followOutputRef={{ current: true }} speech={{ status: 'idle' }} onSpeak={vi.fn()} />
      const view = render(content())
      expand(view.container.querySelector<HTMLDetailsElement>('.agent-activity-process')!)
      const section = view.container.querySelector<HTMLDetailsElement>('.agent-activity-reasoning')!
      const copy = () => within(section).getByRole('button', { name: 'common.copy' })
      expect(section.querySelector('pre')?.textContent).toBe(run.models[0].reasoning)
      fireEvent.click(copy())
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(run.models[0].reasoning))
      run.models[0] = { ...run.models[0], reasoning: run.models[0].reasoning + 'Next step\n' }
      view.rerender(content())
      expect(section.querySelector('pre')?.textContent).toBe(run.models[0].reasoning)
      fireEvent.click(copy())
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(run.models[0].reasoning))
      expect(section.open).toBe(true)
      expand(section)
      expect(section.querySelector('pre')).toBeNull()
      expect(within(section).queryByRole('button', { name: 'common.copy' })).toBeNull()
    })
    it('shows copy actions only in expanded content and copies without toggling the folds', async () => {
      const card = tool('{"ok":true,"id":9007199254740993}')
      for (const [selector, text] of [
        ['.agent-activity-arguments', '{\n  "query": "test"\n}'],
        ['.agent-activity-result', '{\n  "ok": true,\n  "id": 9007199254740993\n}']
      ]) {
        const section = card.querySelector<HTMLDetailsElement>(selector)!
        expect(within(section).queryByRole('button', { name: 'common.copy' })).toBeNull()
        expand(section)
        fireEvent.click(within(section).getByRole('button', { name: 'common.copy' }))
        await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(text))
        await waitFor(() => expect(notice.success).toHaveBeenCalledWith('chat.message_copied'))
        expect(section.open).toBe(true)
        expect(card.open).toBe(true)
        expect(section.querySelector('pre')?.textContent).toBe(text)
        fireEvent.click(section.querySelector('summary')!)
        fireEvent(section, new Event('toggle'))
        expect(within(section).queryByRole('button', { name: 'common.copy' })).toBeNull()
        expect(section.querySelector('pre')).toBeNull()
      }
    })
    it('copies a complete multiline result', async () => {
      const text = 'Unmodified tool output\n'.repeat(1_000)
      const card = tool(text)
      const section = card.querySelector<HTMLDetailsElement>('.agent-activity-result')!
      expand(section)
      fireEvent.click(within(section).getByRole('button', { name: 'common.copy' }))
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(text))
      expect(section.open).toBe(true)
    })
    it('reports a clipboard failure without closing the result or announcing success', async () => {
      writeText.mockRejectedValue(new Error('Clipboard unavailable'))
      const card = tool('plain output')
      const section = card.querySelector<HTMLDetailsElement>('.agent-activity-result')!
      expand(section)
      fireEvent.click(within(section).getByRole('button', { name: 'common.copy' }))
      await waitFor(() => expect(notice.error).toHaveBeenCalledWith('chat.failed_copy_message'))
      expect(notice.success).not.toHaveBeenCalled()
      expect(section.open).toBe(true)
      expect(card.open).toBe(true)
    })
  })

  it('removes an interrupted argument reception without exposing partial input', () => {
    const run = activity('running')
    run.tools = []
    run.models = [{ id: 'model', sequence: 0, status: 'running', text: '', reasoning: '', toolCallIds: [],
      toolCallProgress: [{ index: 0, name: 'apply_patch', characterCount: 50, complete: false }] }]
    const props = { title: 'Thread', messages, panelRef: { current: null }, followOutputRef: { current: true }, speech: { status: 'idle' as const }, onSpeak: vi.fn() }
    const view = render(<AgentMessageList {...props} activities={[run]} />)
    expand(view.container.querySelector<HTMLDetailsElement>('.agent-activity-process')!)
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
    expand(document.querySelector<HTMLDetailsElement>('.agent-subagent-result')!)
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
    expect(screen.queryByText('SUBAGENT_FAILURE')).toBeNull()
    expand(document.querySelector<HTMLDetailsElement>('.agent-subagent-error')!)
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
    expect(screen.queryByText('SUBAGENT_RECOVERY_FAILURE')).toBeNull()
    expand(document.querySelector<HTMLDetailsElement>('.agent-subagent-error')!)
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
