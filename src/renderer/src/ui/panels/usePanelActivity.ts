import { useEffect, useState } from 'react'
import type { AgentRunActivity, AgentRuntimeEvent } from '@shared/agentTypes'
import { applyRunActivityEvent } from '@shared/agentActivityProjection'
import { boundedDisplayRun, displayEvent } from '@shared/activityDisplay'
import { contentServices } from './contentServices'

/** Only headers live with the panel. Its mounted window/details own all bodies. */
export function usePanelActivity(threadId: string, runId: string, subagentId: string) {
  const [run, setRun] = useState<AgentRunActivity>()
  const [error, setError] = useState<unknown>()
  useEffect(() => {
    let active = true, refresh: Promise<void> | undefined, invalidated = false
    let buffered: AgentRuntimeEvent[] = []
    setRun(undefined)
    const synchronize = (afterCommit = false): Promise<void> => {
      if (refresh) { invalidated ||= afterCommit; return refresh }
      refresh = (async () => {
        do {
          invalidated = false; buffered = []
          const [snapshot, selected] = await Promise.all([
            contentServices().agent.activities.get({ threadId, runId }),
            contentServices().agent.activities.subagent({ threadId, runId, subagentId })
          ])
          if (!active) return
          let incoming = { ...snapshot, subagents: [...snapshot.subagents.filter(item => item.id !== selected.id), selected] }
          for (const event of buffered) incoming = applyRunActivityEvent(incoming, event)
          setRun(boundedDisplayRun(threadId, incoming)); setError(undefined)
        } while (active && invalidated)
      })().finally(() => { refresh = undefined; buffered = [] })
      return refresh
    }
    const stop = contentServices().agent.onEvent(event => {
      const owner = 'run' in event ? event.run.threadId : event.threadId
      const id = 'run' in event ? event.run.id : 'runId' in event ? event.runId : undefined
      if (owner !== threadId || id !== runId) return
      const lean = displayEvent(event)
      if (refresh) buffered.push(lean)
      setRun(previous => previous ? boundedDisplayRun(threadId, applyRunActivityEvent(previous, lean)) : previous)
      if (['run_completed', 'run_failed', 'run_cancelled', 'run_interrupted', 'run_settled', 'run_recovery_failed'].includes(event.type)) {
        void synchronize(true).catch(reason => { if (active) setError(reason) })
      }
    }, synchronize, message => { if (active) setError(message) })
    return () => { active = false; buffered = []; stop() }
  }, [threadId, runId, subagentId])
  return { run, error }
}
