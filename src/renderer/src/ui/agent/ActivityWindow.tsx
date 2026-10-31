import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentRunActivity, AgentRuntimeEvent } from '@shared/agentTypes'
import { activityInitialSize, activityPageSize, activityWindowLimit } from '@shared/activityDisplay'
import { displayActivityPage, displayEvent } from '@shared/activityDisplay'
import { applyRunActivityEvent } from '@shared/agentActivityProjection'
import { contentServices } from '../panels/contentServices'
import { NoFocusButton } from '../NoFocusButton'
import { agentActionError } from './agentErrorMessage'
import type { ActivityBoundaryRequest } from '../chat/ScrollBoundaryNavigation'

export interface ActivityPageSlot {
  start: number
  end: number
  count: number
  height: number
  data?: AgentRunActivity
}

type ReadDirection = 'first' | 'latest' | 'before' | 'after' | 'restore'
type Locate = boolean | ActivityBoundaryRequest

function isActivityEventFor(event: AgentRuntimeEvent, subagentId?: string): boolean {
  if ('model' in event) return event.model.subagentId === subagentId
  if ('modelId' in event || 'call' in event) return event.subagentId === subagentId
  if (event.type === 'subagent_updated') return event.subagent.parentSubagentId === subagentId
  if (event.type === 'memory_recalled' || event.type.startsWith('context_compression_')) return subagentId === undefined
  return event.type.startsWith('run_')
}

export function splitActivityPage(run: AgentRunActivity): ActivityPageSlot[] {
  const sequences = [...new Set([...run.models, ...run.tools, ...run.subagents, ...(run.summaries ?? []), ...(run.memoryRecalls ?? [])]
    .map(item => item.sequence).filter(sequence => sequence >= (run.activityWindow?.startSequence ?? 0)
      && sequence <= (run.activityWindow?.endSequence ?? Number.MAX_SAFE_INTEGER)))].sort((a, b) => a - b)
  const slots: ActivityPageSlot[] = []
  for (let index = 0; index < sequences.length; index += activityPageSize) {
    const selected = sequences.slice(index, index + activityPageSize), start = selected[0], end = selected.at(-1)!
    const within = <T extends { sequence: number }>(items: T[]) => items.filter(item => item.sequence >= start && item.sequence <= end)
    slots.push({ start, end, count: selected.length, height: -1, data: { ...run,
      activityWindow: { startSequence: start, endSequence: end, totalCount: run.activityWindow?.totalCount ?? sequences.length,
        hasEarlier: index > 0 || Boolean(run.activityWindow?.hasEarlier),
        hasLater: index + activityPageSize < sequences.length || Boolean(run.activityWindow?.hasLater) },
      models: within(run.models), tools: within(run.tools), subagents: within(run.subagents),
      summaries: within(run.summaries ?? []), memoryRecalls: within(run.memoryRecalls ?? []) } })
  }
  return slots
}

/** Retain only metadata and measured height for pages outside the reading window. */
export function evictActivityPages(slots: ActivityPageSlot[], focus: number): ActivityPageSlot[] {
  let count = slots.reduce((total, slot) => total + (slot.data ? slot.count : 0), 0)
  const result = [...slots]
  const candidates = slots.map((_, index) => index).filter(index => index !== focus)
    .sort((a, b) => Math.abs(b - focus) - Math.abs(a - focus))
  for (const index of candidates) {
    if (count <= activityWindowLimit) break
    if (!result[index].data || result[index].height < 0) continue
    count -= result[index].count
    result[index] = { ...result[index], data: undefined }
  }
  return result
}

function Page({ slot, active, load, measure, children }: { slot: ActivityPageSlot; active: boolean; load(): void; measure(height: number): void; children: ReactNode }) {
  const loaded = slot.data !== undefined
  const ref = useRef<HTMLDivElement>(null)
  const actions = useRef({ load, measure }); actions.current = { load, measure }
  useEffect(() => {
    const element = ref.current!
    const root = element.closest('.workspace-content-scroll, .agent-subagent-panel-body')
    const visible = new IntersectionObserver(entries => {
      if (active && entries.some(entry => entry.isIntersecting)) actions.current.load()
    }, { root, rootMargin: '500px 0px' })
    visible.observe(element)
    const resize = new ResizeObserver(() => {
      if (loaded) actions.current.measure(element.getBoundingClientRect().height)
    })
    resize.observe(element)
    return () => { visible.disconnect(); resize.disconnect() }
  }, [loaded, active])
  return <div ref={ref} data-activity-page={slot.start} style={slot.data ? undefined : { height: Math.max(0, slot.height), overflowAnchor: 'none' }}>{children}</div>
}

function Boundary({ active, direction, load, children }: { active: boolean; direction: 'before' | 'after'; load(): void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null), action = useRef(load); action.current = load
  useEffect(() => {
    if (!active) return
    const element = ref.current!
    const panel = element.closest('.workspace-content-scroll, .agent-subagent-panel-body')
    if (!panel) return
    let previousTop = panel.scrollTop, requested = false
    const advance = (delta: number) => {
      if (requested || (direction === 'before' ? delta >= 0 : delta <= 0)) return
      const bounds = panel.getBoundingClientRect(), boundary = element.getBoundingClientRect()
      if (boundary.bottom < bounds.top - 200 || boundary.top > bounds.bottom + 200) return
      requested = true
      action.current()
    }
    const scroll = () => {
      const delta = panel.scrollTop - previousTop
      previousTop = panel.scrollTop
      advance(delta)
    }
    // A newly mounted boundary is not a request to paginate. Require movement
    // towards it; wheel input also works when already at the scroll limit.
    const wheel = (event: Event) => { if (!event.defaultPrevented && !(event as WheelEvent).ctrlKey) advance((event as WheelEvent).deltaY) }
    panel.addEventListener('scroll', scroll, { passive: true })
    panel.addEventListener('wheel', wheel, { passive: true })
    return () => { panel.removeEventListener('scroll', scroll); panel.removeEventListener('wheel', wheel) }
  }, [active, direction])
  return <div ref={ref}>{children}</div>
}

export function ActivityWindow({ threadId, run, subagentId, children }: {
  threadId: string
  subagentId?: string
  run: AgentRunActivity
  children(page: AgentRunActivity): ReactNode
}) {
  const { t } = useTranslation()
  const root = useRef<HTMLDivElement>(null)
  const [slots, setSlots] = useState<ActivityPageSlot[]>([])
  const current = useRef(slots); current.current = slots
  const [earlier, setEarlier] = useState(false), [later, setLater] = useState(false)
  const [loading, setLoading] = useState(false), [error, setError] = useState<unknown>()
  const generation = useRef(0), busy = useRef(false)
  const focusStart = useRef<number | undefined>(undefined)
  const pendingNavigation = useRef<{ direction: 'first' | 'latest'; locate: Locate; interaction: number } | undefined>(undefined)
  const hasLater = useRef(false)
  const status = subagentId ? run.subagents.find(item => item.id === subagentId)?.status : run.status
  const initialDirection = useRef<'first' | 'latest'>('first')
  initialDirection.current = status === 'running' || status === 'interrupted' ? 'latest' : 'first'
  const interaction = useRef(0)
  const navigationVersion = useRef(0)
  const position = useRef<{ edge: 'first' | 'latest'; interaction: number; panel: boolean; onPosition?(): void } | undefined>(undefined)
  const lastRead = useRef<{ direction: ReadDirection; start?: number; locate: Locate }>({ direction: initialDirection.current, locate: true })
  const tailSequence = useRef(-1)
  const pendingEvents = useRef(new Map<string, AgentRuntimeEvent>())
  const readOverflow = useRef(false)
  const anchor = useRef<{ key: string; top: number } | undefined>(undefined)
  const capture = () => {
    const panel = root.current?.closest('.workspace-content-scroll, .agent-subagent-panel-body')
    if (!panel) return
    const top = panel.getBoundingClientRect().top
    const element = [...root.current!.querySelectorAll<HTMLElement>('[data-activity-page]')]
      .find(item => item.getBoundingClientRect().bottom > top)
    if (element) anchor.current = { key: element.dataset.activityPage!, top: element.getBoundingClientRect().top }
  }
  useLayoutEffect(() => {
    const target = position.current; position.current = undefined
    const saved = anchor.current; anchor.current = undefined
    const panel = root.current?.closest('.workspace-content-scroll, .agent-subagent-panel-body')
    if (target && panel && root.current) {
      if (target.interaction !== interaction.current) return
      if (target.panel) {
        panel.scrollTop = target.edge === 'first' ? 0 : panel.scrollHeight
        target.onPosition?.()
        return
      }
      const bounds = panel.getBoundingClientRect(), content = root.current.getBoundingClientRect()
      if (target.edge === 'latest') panel.scrollTop += content.bottom - bounds.bottom
      else if (content.top < bounds.top || content.top >= bounds.bottom) panel.scrollTop += content.top - bounds.top
      return
    }
    if (!saved) return
    const element = root.current?.querySelector<HTMLElement>(`[data-activity-page="${saved.key}"]`)
    if (element && panel) panel.scrollTop += element.getBoundingClientRect().top - saved.top
  }, [slots])
  const read = useCallback(async (direction: ReadDirection, start?: number, locate: Locate = false) => {
    if (busy.current) {
      if ((direction === 'latest' || direction === 'first') && (!pendingNavigation.current || locate)) pendingNavigation.current = { direction, locate, interaction: interaction.current }
      return
    }
    lastRead.current = { direction, start, locate }
    const requestedAt = interaction.current
    let previous = current.current
    const restore = previous.find(slot => slot.start === start)
    if (direction === 'restore' && !restore) return
    const before = direction === 'before' ? previous[0]?.start : direction === 'restore' ? restore!.end + 1 : undefined
    const after = direction === 'first' ? -1 : direction === 'after' ? previous.at(-1)?.end ?? -1 : undefined
    const own = generation.current
    const navigation = navigationVersion.current
    const superseded = () => current.current.length > 0 && (navigation !== navigationVersion.current
      || (direction === 'first' || direction === 'latest') && requestedAt !== interaction.current)
    busy.current = true; setLoading(true); setError(undefined)
    try {
      let page: AgentRunActivity
      do {
        pendingEvents.current.clear(); readOverflow.current = false
        page = await contentServices().agent.activities.page({ threadId, runId: run.runId, subagentId, before, after,
          limit: direction === 'latest' || direction === 'first' ? activityInitialSize : direction === 'restore' ? restore!.count : activityPageSize })
        if (own !== generation.current) return
        if (superseded()) return
      } while (readOverflow.current)
      // Live completions may arrive while the IPC snapshot is in flight. Keep
      // only bounded invalidations, never payloads, and apply them before paint.
      for (const event of pendingEvents.current.values()) {
        page = displayActivityPage(threadId, applyRunActivityEvent(page, event))
        if (event.type === 'model_delta') page = { ...page, models: page.models.map(model =>
          model.id === event.modelId && model.subagentId === event.subagentId
            ? { ...model, hasText: model.hasText || event.delta.type === 'text', hasReasoning: model.hasReasoning || event.delta.type === 'reasoning' } : model) }
      }
      pendingEvents.current.clear()
      const scoped = <T extends { subagentId?: string }>(items: T[]) => items.filter(item => item.subagentId === subagentId)
      page = { ...page, models: scoped(page.models), tools: scoped(page.tools), subagents: page.subagents.filter(item => item.parentSubagentId === subagentId) }
      if (direction === 'latest' && page.activityWindow) page.activityWindow = { ...page.activityWindow,
        endSequence: Math.max(page.activityWindow.endSequence ?? -1, tailSequence.current) }
      if (direction === 'restore' && page.activityWindow) page.activityWindow = { ...page.activityWindow,
        startSequence: restore!.start, endSequence: Math.max(restore!.end, current.current.find(slot => slot.start === start)?.end ?? -1) }
      if (page.activityWindow) {
        const start = page.activityWindow.startSequence ?? 0, end = page.activityWindow.endSequence ?? -1
        const entries = [...page.models, ...page.tools, ...page.subagents, ...(page.summaries ?? []), ...(page.memoryRecalls ?? [])]
        // Events received after the snapshot may belong to a later page. Keep
        // that page reachable without inserting its rows into a restored slot.
        const within = <T extends { sequence: number }>(items: T[]) => items.filter(item => item.sequence >= start && item.sequence <= end)
        page = { ...page, activityWindow: { ...page.activityWindow,
          hasLater: Boolean(page.activityWindow.hasLater) || entries.some(item => item.sequence > end) },
          models: within(page.models), tools: within(page.tools), subagents: within(page.subagents),
          summaries: page.summaries && within(page.summaries), memoryRecalls: page.memoryRecalls && within(page.memoryRecalls) }
      }
      previous = current.current.map(slot => {
        const element = root.current?.querySelector<HTMLElement>(`[data-activity-page="${slot.start}"]`)
        return slot.data && element ? { ...slot, height: element.getBoundingClientRect().height } : slot
      })
      if (locate && (direction === 'first' || direction === 'latest')) {
        anchor.current = undefined
        position.current = { edge: direction, interaction: requestedAt, panel: typeof locate === 'object',
          onPosition: typeof locate === 'object' ? locate.onPosition : undefined }
      } else capture()
      const incoming = splitActivityPage(page)
      if (direction === 'after') tailSequence.current = Math.max(tailSequence.current, incoming.at(-1)?.end ?? -1)
      let next: ActivityPageSlot[]
      if (direction === 'latest' || direction === 'first') {
        next = incoming; tailSequence.current = incoming.at(-1)?.end ?? -1
        setEarlier(Boolean(page.activityWindow?.hasEarlier))
        hasLater.current = Boolean(page.activityWindow?.hasLater); setLater(hasLater.current)
      }
      else if (direction === 'before') {
        next = [...incoming.filter(slot => slot.end < (previous[0]?.start ?? Infinity)), ...previous]
        setEarlier(Boolean(page.activityWindow?.hasEarlier))
      } else if (direction === 'after') {
        next = [...previous, ...incoming.filter(slot => slot.start > (previous.at(-1)?.end ?? -1))]
        hasLater.current = Boolean(page.activityWindow?.hasLater); setLater(hasLater.current)
      } else {
        next = previous.map(slot => slot.start === start ? { ...slot, data: page } : slot)
        if (restore?.end === previous.at(-1)?.end) { hasLater.current = Boolean(page.activityWindow?.hasLater); setLater(hasLater.current) }
      }
      const focus = direction === 'before' || direction === 'first' ? 0 : direction === 'restore' ? next.findIndex(slot => slot.start === start) : next.length - 1
      focusStart.current = next[focus]?.start
      current.current = evictActivityPages(next, focus); setSlots(current.current)
    } catch (reason) {
      if (own === generation.current && !superseded()) setError(reason)
    } finally {
      if (own === generation.current) {
        pendingEvents.current.clear()
        busy.current = false; setLoading(false)
        const pending = pendingNavigation.current; pendingNavigation.current = undefined
        if (pending && pending.interaction === interaction.current) void read(pending.direction, undefined, pending.locate)
      }
    }
  }, [threadId, run.runId, subagentId])
  useEffect(() => {
    const own = ++generation.current
    const pending = pendingEvents.current
    busy.current = false; pendingNavigation.current = undefined; pendingEvents.current.clear(); tailSequence.current = -1; current.current = []; setSlots([])
    hasLater.current = false; setEarlier(false); setLater(false); position.current = undefined; anchor.current = undefined
    setLoading(true)
    let timer: ReturnType<typeof setTimeout> | undefined
    const panel = root.current?.closest('.workspace-content-scroll, .agent-subagent-panel-body')
    const moved = () => { interaction.current++ }
    const inputEvents = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const
    for (const name of inputEvents) panel?.addEventListener(name, moved, { passive: true, capture: true })
    const navigate = (event: Event) => {
      const { edge } = (event as CustomEvent<ActivityBoundaryRequest>).detail
      // A panel command supersedes navigation in every open run, including
      // a pending request owned by the opposite end of this same panel.
      interaction.current++
      navigationVersion.current++
      const windows = [...(panel?.querySelectorAll('.agent-activity-window') ?? [])]
        .filter(element => element.closest('.workspace-content-scroll, .agent-subagent-panel-body') === panel)
      if ((edge === 'first' ? windows[0] : windows.at(-1)) !== root.current) return
      event.preventDefault()
      void read(edge, undefined, (event as CustomEvent<ActivityBoundaryRequest>).detail)
    }
    const synchronize = async () => {
      const navigation = navigationVersion.current
      if (!current.current.length) await read(initialDirection.current, undefined, true)
      else for (const slot of current.current.filter(item => item.data)) {
        if (generation.current !== own || navigation !== navigationVersion.current) return
        await read('restore', slot.start)
      }
    }
    panel?.addEventListener('activity-boundary', navigate)
    const stop = contentServices().agent.onEvent((incoming: AgentRuntimeEvent) => {
      const event = displayEvent(incoming)
      const owner = 'run' in event ? event.run.threadId : event.threadId
      const id = 'run' in event ? event.run.id : 'runId' in event ? event.runId : undefined
      if (owner !== threadId || id !== run.runId) return
      if (!isActivityEventFor(event, subagentId)) return
      if (busy.current) {
        const key = event.type + ('modelId' in event ? event.modelId : 'model' in event ? event.model.id
          : 'call' in event ? event.call.id : 'subagent' in event ? event.subagent.id : 'recall' in event ? event.recall.id
          : 'summary' in event ? event.summary.id : 'summaryId' in event ? event.summaryId : '') + (event.type === 'model_delta' ? event.delta.type : '')
        if (pendingEvents.current.size < activityWindowLimit || pendingEvents.current.has(key)) pendingEvents.current.set(key, displayEvent(event))
        else readOverflow.current = true
      }
      if (event.type === 'model_delta') {
        setSlots(previous => previous.map(slot => slot.data ? { ...slot, data: { ...slot.data, models: slot.data.models.map(model =>
          model.id === event.modelId ? { ...model, hasText: model.hasText || event.delta.type === 'text', hasReasoning: model.hasReasoning || event.delta.type === 'reasoning' } : model) } } : slot))
        return
      }
      const sequence = (event.type === 'model_started' || event.type === 'model_completed') && event.model.subagentId === subagentId ? event.model.sequence
        : (event.type === 'tool_started' || event.type === 'tool_completed' || event.type === 'tool_approval_requested') && event.subagentId === subagentId ? event.sequence
        : event.type === 'subagent_updated' && event.subagent.parentSubagentId === subagentId ? event.subagent.sequence
        : !subagentId && event.type === 'memory_recalled' ? event.recall.sequence
        : !subagentId && (event.type === 'context_compression_started' || event.type === 'context_compression_completed') ? event.summary.sequence : undefined
      const previousTail = tailSequence.current
      if (sequence !== undefined) tailSequence.current = Math.max(previousTail, sequence)
      setSlots(previous => {
        const next = previous.flatMap(slot => {
        if (!slot.data) return [slot]
        const updated = displayActivityPage(threadId, applyRunActivityEvent(slot.data, event))
        const end = !hasLater.current && slot === previous.at(-1) && slot.end === previousTail && sequence !== undefined ? Math.max(slot.end, sequence) : slot.end
        const within = <T extends { sequence: number }>(items: T[]) => items.filter(item => item.sequence >= slot.start && item.sequence <= end)
        const data = { ...updated, activityWindow: { startSequence: slot.start, endSequence: end,
          totalCount: updated.activityWindow?.totalCount ?? 0, hasEarlier: updated.activityWindow?.hasEarlier ?? false },
          models: within(updated.models), tools: within(updated.tools), subagents: within(updated.subagents),
          summaries: within(updated.summaries ?? []), memoryRecalls: within(updated.memoryRecalls ?? []) }
        const count = slot.count + (end > slot.end ? 1 : 0)
        return count > activityPageSize ? splitActivityPage(data).map(part => ({ ...part, height: part.start === slot.start ? slot.height : -1 }))
          : [{ ...slot, end, count, data }]
        })
        return evictActivityPages(next, Math.max(0, next.findIndex(slot => slot.start === focusStart.current)))
      })
      const atBottom = panel ? panel.scrollHeight - panel.clientHeight - panel.scrollTop < 80 : true
      const wasAtEnd = !hasLater.current
      if (sequence !== undefined && sequence > previousTail && (hasLater.current || !current.current.at(-1)?.data)) {
        hasLater.current = true; setLater(true)
      }
      // Missing tail data remains reachable even if input cancels the delayed
      // refresh. Only refresh an idle tail view, never replace a newer read.
      if (atBottom && wasAtEnd && !busy.current && timer === undefined) {
        const requestedAt = interaction.current
        const requestedRead = lastRead.current
        timer = setTimeout(() => {
          timer = undefined
          if (interaction.current === requestedAt && lastRead.current === requestedRead
            && (!panel || panel.scrollHeight - panel.clientHeight - panel.scrollTop < 80)) void read('latest')
        }, 150)
      }
    }, synchronize, reason => { if (generation.current === own) { setError(reason); setLoading(false) } })
    return () => {
      generation.current = own + 1; busy.current = false; pending.clear(); clearTimeout(timer); stop(); panel?.removeEventListener('activity-boundary', navigate)
      for (const name of inputEvents) panel?.removeEventListener(name, moved, true)
    }
  }, [threadId, run.runId, subagentId, read])
  return <div ref={root} className="agent-activity-window">
    {Boolean(error) && <div role="alert">{agentActionError(t('agent.load_earlier_activities_failed'), error)} <NoFocusButton onClick={() => void read(lastRead.current.direction, lastRead.current.start, lastRead.current.locate)}>{t('common.retry')}</NoFocusButton></div>}
    <Boundary active={earlier && !loading && !error} direction="before" load={() => void read('before')}>
      {earlier && <NoFocusButton disabled={loading} onClick={() => void read('before')}>{t('agent.load_earlier_activities')}</NoFocusButton>}
    </Boundary>
    {!loading && !error && slots.length === 0 && children({ ...run, models: [], tools: [], subagents: [], summaries: [], memoryRecalls: [],
      activityWindow: { startSequence: null, endSequence: null, totalCount: 0, hasEarlier: false } })}
    {slots.map(slot => <Page key={slot.start} slot={slot} active={!loading && !error}
      load={() => { if (!slot.data && !error) void read('restore', slot.start); else if (slot.data) focusStart.current = slot.start }}
      measure={height => { if (height >= 0 && (slot.height < 0 || Math.abs(height - slot.height) > 1)) setSlots(previous => evictActivityPages(
        previous.map(item => item.start === slot.start ? { ...item, height } : item), previous.findIndex(item => item.start === focusStart.current))) }}>
      {slot.data && children(slot.data)}
    </Page>)}
    {loading && <span role="status">{t('common.loading')}</span>}
    <Boundary active={later && !loading && !error} direction="after" load={() => void read('after')}>
      {later && <>
        <NoFocusButton disabled={loading} onClick={() => void read('after')}>{t('agent.load_later_activities')}</NoFocusButton>
        <NoFocusButton disabled={loading} data-scroll-follow-toggle onClick={() => void read('latest', undefined, true)}>{t('agent.latest_activities')}</NoFocusButton>
      </>}
    </Boundary>
  </div>
}
