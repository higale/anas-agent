import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentRunActivity, AgentRuntimeEvent } from '@shared/agentTypes'
import { applyRunActivityEvent } from '@shared/agentActivityProjection'
import { mergeActivityPage, mergeSubagentDetails, preserveEarlierActivities } from '../agent/activityPagination'
import { throwIfAborted } from '../agent/messagePagination'
import type { EarlierActivityRequest } from '../agent/AgentMessageList'
import { usePanelRef } from '../agent/PanelViewState'
import { contentServices } from './contentServices'

/** A view projection of one run. It never recovers, starts, or cancels execution. */
export function usePanelActivity(threadId: string, runId: string, subagentId: string) {
  const [run, setRun] = useState<AgentRunActivity>()
  const [error, setError] = useState<unknown>()
  const earliest = usePanelRef<number | null>('activities.earliest', null)
  const current = useRef(run)
  const generation = useRef(0)
  const update = useCallback((change: (run: AgentRunActivity | undefined) => AgentRunActivity | undefined) => {
    current.current = change(current.current)
    setRun(current.current)
  }, [])
  useEffect(() => {
    const own = ++generation.current
    let active = true
    let refresh: Promise<void> | undefined
    let invalidated = false
    let buffered: AgentRuntimeEvent[] = []
    const synchronize = (afterCommit = false) => {
      if (refresh) { invalidated ||= afterCommit; return refresh }
      refresh = (async () => {
        do {
          invalidated = false
          buffered = []
          const [snapshot, selected] = await Promise.all([
            contentServices().agent.activities.get({ threadId, runId }),
            contentServices().agent.activities.subagent({ threadId, runId, subagentId })
          ])
          let incoming = snapshot
          while (active && earliest.current !== null && incoming.activityWindow?.hasEarlier
            && incoming.activityWindow.startSequence !== null && incoming.activityWindow.startSequence > earliest.current) {
            const before = incoming.activityWindow.startSequence
            const earlier = await contentServices().agent.activities.loadEarlier({ threadId, runId, beforeSequence: before })
            const merged = mergeActivityPage(incoming, earlier, before)
            if (merged.activityWindow?.startSequence === before) break
            incoming = merged
          }
          if (!active) return
          if (!incoming.subagents.some(item => item.id === selected.id)) incoming.subagents.push(selected)
          else incoming.subagents = incoming.subagents.map(item => mergeSubagentDetails(item, selected))
          update(previous => {
            let projected = incoming ? preserveEarlierActivities(previous, incoming) : undefined
            for (const event of buffered) if (projected) projected = applyRunActivityEvent(projected, event)
            return projected
          })
          setError(undefined)
        } while (active && invalidated)
      })().finally(() => { refresh = undefined; buffered = [] })
      return refresh
    }
    const stop = contentServices().agent.onEvent(event => {
      const owner = 'run' in event ? event.run.threadId : event.threadId
      const id = 'run' in event ? event.run.id : 'runId' in event ? event.runId : undefined
      if (owner !== threadId || id !== runId) return
      if (refresh) buffered.push(event)
      update(previous => previous ? applyRunActivityEvent(previous, event) : previous)
      if (['run_completed', 'run_failed', 'run_cancelled', 'run_interrupted', 'run_settled', 'run_recovery_failed'].includes(event.type)) {
        void synchronize(true).catch(reason => { if (active) setError(reason) })
      }
    }, synchronize, message => { if (active) setError(message) })
    return () => { active = false; stop(); if (generation.current === own) generation.current++ }
  }, [threadId, runId, subagentId, update, earliest])
  const loadEarlier = useCallback(async ({ signal }: EarlierActivityRequest) => {
    const cursor = current.current?.activityWindow
    if (!cursor?.hasEarlier || cursor.startSequence === null) return
    const own = generation.current
    throwIfAborted(signal)
    const page = await contentServices().agent.activities.loadEarlier({ threadId, runId, beforeSequence: cursor.startSequence })
    throwIfAborted(signal)
    if (own === generation.current) update(previous => {
      const next = previous ? mergeActivityPage(previous, page, cursor.startSequence!) : previous
      earliest.current = next?.activityWindow?.startSequence ?? null
      return next
    })
  }, [threadId, runId, update, earliest])
  const loadDetails = useCallback(async (_threadId: string, _runId: string, subagentId: string) => {
    const own = generation.current
    const details = await contentServices().agent.activities.subagent({ threadId, runId, subagentId })
    if (own === generation.current) update(previous => previous ? { ...previous,
      subagents: previous.subagents.map(item => mergeSubagentDetails(item, details)) } : previous)
  }, [threadId, runId, update, earliest])
  return { run, error, loadEarlier, loadDetails }
}
