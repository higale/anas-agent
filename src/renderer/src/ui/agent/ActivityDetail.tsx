import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentActivityDetail, AgentActivityDetailReference } from '@shared/agentTypes'
import { contentServices } from '../panels/contentServices'
import { NoFocusButton } from '../NoFocusButton'
import { agentActionError } from './agentErrorMessage'

/** Owned exclusively by the mounted body. No payload is stored in panel state. */
export function ActivityDetail({ reference, field, children }: {
  reference: AgentActivityDetailReference
  field: keyof AgentActivityDetail
  children(value: unknown): ReactNode
}) {
  const { t } = useTranslation()
  const [state, setState] = useState<{ value?: unknown; loaded?: boolean; error?: unknown }>({})
  const [attempt, retry] = useState(0)
  const { threadId, runId, kind, id, subagentId } = reference
  useEffect(() => {
    let disposed = false, reading = false, dirty = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setState({})
    const refresh = async () => {
      if (reading) { dirty = true; return }
      reading = true
      try {
        const result = await contentServices().agent.activities.detail({ threadId, runId, kind, id, subagentId, field })
        if (!disposed) setState({ loaded: true, value: result[field] })
      } catch (error) {
        if (!disposed) setState({ error })
      } finally {
        reading = false
        if (!disposed && dirty) { dirty = false; schedule() }
      }
    }
    const schedule = () => { timer ??= setTimeout(() => { timer = undefined; void refresh() }, 80) }
    const stop = contentServices().agent.onEvent(event => {
      const owner = 'run' in event ? event.run.threadId : event.threadId
      const ownerRun = 'run' in event ? event.run.id : 'runId' in event ? event.runId : undefined
      if (owner !== threadId || ownerRun !== runId) return
      if (kind === 'model' && ((event.type === 'model_delta' || event.type === 'model_tool_calls') && event.modelId === id && event.subagentId === subagentId
        || (event.type === 'model_started' || event.type === 'model_completed') && event.model.id === id && event.model.subagentId === subagentId)) schedule()
      else if (kind === 'tool' && (event.type === 'tool_started' || event.type === 'tool_completed' || event.type === 'tool_approval_requested')
        && event.call.id === id && event.subagentId === subagentId) schedule()
      else if (kind === 'subagent' && event.type === 'subagent_updated' && event.subagent.id === id) schedule()
      else if (event.type.startsWith('run_') || event.type === 'context_compression_completed') schedule()
    }, refresh, error => { if (!disposed) setState({ error }) })
    return () => { disposed = true; clearTimeout(timer); stop() }
  }, [threadId, runId, kind, id, subagentId, field, attempt])
  if (state.error) return <div role="alert">{agentActionError(t('agent.load_activity_detail_failed'), state.error)} <NoFocusButton onClick={() => retry(value => value + 1)}>{t('common.retry')}</NoFocusButton></div>
  if (!state.loaded) return <span role="status">{t('common.loading')}</span>
  return children(state.value)
}
