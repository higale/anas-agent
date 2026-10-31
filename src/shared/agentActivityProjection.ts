import type { AgentRunActivity, AgentRuntimeEvent } from './agentTypes'
import { applySubagentActivityUpdate } from './agentActivity'

function upsert<T>(items: T[], value: T, matches: (item: T) => boolean): T[] {
  return items.some(matches) ? items.map(item => matches(item) ? value : item) : [...items, value]
}

/** Shared presentation reducer; execution and persistence remain in the single Agent runtime. */
function reduceRunActivityEvent<T extends AgentRunActivity>(run: T, event: AgentRuntimeEvent): T {
  if ('run' in event && event.run.id === run.runId) return { ...run, status: event.run.status,
    error: event.run.error, updatedAt: event.run.updatedAt, backgroundCleanup: event.run.backgroundCleanup }
  if (!('runId' in event) || event.runId !== run.runId) return run
  switch (event.type) {
    case 'memory_recalled': return { ...run, memoryRecalls: upsert(run.memoryRecalls ?? [], event.recall, item => item.id === event.recall.id) }
    case 'context_compression_started':
    case 'context_compression_completed': return { ...run, summaries: upsert(run.summaries ?? [], event.summary, item => item.id === event.summary.id) }
    case 'context_compression_discarded': return { ...run, summaries: run.summaries?.filter(item => item.id !== event.summaryId) }
    case 'model_started':
    case 'model_completed': {
      const matches = (item: T['models'][number]) => item.id === event.model.id && item.subagentId === event.model.subagentId
      const previous = run.models.find(matches)
      const model = previous ? { ...event.model, round: event.model.round ?? previous.round, toolCallProgress: previous.toolCallProgress } : event.model
      return { ...run, models: upsert(run.models, model, matches) }
    }
    case 'model_delta':
    case 'model_tool_calls': return { ...run, models: run.models.map(model => {
      if (model.id !== event.modelId || model.subagentId !== event.subagentId) return model
      if (event.type === 'model_tool_calls') return { ...model, toolCallProgress: event.progress }
      if (model.status === 'completed') return model
      return event.delta.type === 'reasoning' ? { ...model, hasReasoning: true, reasoning: model.reasoning + event.delta.text }
        : { ...model, hasText: true, text: model.text + event.delta.text }
    }) }
    case 'tool_started':
    case 'tool_approval_requested':
    case 'tool_completed': return { ...run, tools: upsert(run.tools, {
      call: event.call, sequence: event.sequence, status: event.type === 'tool_completed' ? 'completed' : 'running',
      subagentId: event.subagentId, startedAt: event.startedAt,
      ...(event.type === 'tool_approval_requested' ? { approval: event.approval } : {}),
      ...(event.type === 'tool_completed' ? { output: event.output, completedAt: event.completedAt } : {})
    }, item => item.call.id === event.call.id && item.subagentId === event.subagentId) }
    case 'subagent_updated': return applySubagentActivityUpdate(run, event.subagent)
    default: return run
  }
}

/** Count new records once even after their page was evicted and events replay. */
export function applyRunActivityEvent<T extends AgentRunActivity>(run: T, event: AgentRuntimeEvent): T {
  const updated = reduceRunActivityEvent(run, event)
  if (!run.display || updated === run) return updated
  const sequence = event.type === 'model_started' || event.type === 'model_completed' ? event.model.sequence
    : event.type === 'tool_started' || event.type === 'tool_completed' || event.type === 'tool_approval_requested' ? event.sequence
    : event.type === 'subagent_updated' ? event.subagent.sequence : undefined
  if (sequence === undefined || sequence <= (run.display.lastSequence ?? -1)) return updated
  const rootModel = (event.type === 'model_started' || event.type === 'model_completed') && !event.model.subagentId
  const rootTool = (event.type === 'tool_started' || event.type === 'tool_completed' || event.type === 'tool_approval_requested') && !event.subagentId
  const rootChild = event.type === 'subagent_updated' && !event.subagent.parentSubagentId
  const owner = event.type === 'model_started' || event.type === 'model_completed' ? event.model.subagentId
    : event.type === 'subagent_updated' ? event.subagent.parentSubagentId : 'subagentId' in event ? event.subagentId : undefined
  return { ...updated, subagents: updated.subagents.map(child => {
    const counts = child.activityCounts
    if (!counts || child.id !== owner || sequence <= (counts.lastSequence ?? -1)) return child
    return { ...child, activityCounts: { lastSequence: sequence,
      modelCount: counts.modelCount + Number(event.type === 'model_started' || event.type === 'model_completed'),
      toolCount: counts.toolCount + Number(event.type === 'tool_started' || event.type === 'tool_completed' || event.type === 'tool_approval_requested'),
      subagentCount: counts.subagentCount + Number(event.type === 'subagent_updated') } }
  }), display: { ...run.display, lastSequence: sequence,
    modelCount: run.display.modelCount + Number(rootModel), toolCount: run.display.toolCount + Number(rootTool),
    subagentCount: run.display.subagentCount + Number(rootChild) } }
}
