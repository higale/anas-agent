import type { AgentRunActivity, AgentRuntimeEvent } from './agentTypes'
import { applySubagentActivityUpdate } from './agentActivity'

function upsert<T>(items: T[], value: T, matches: (item: T) => boolean): T[] {
  return items.some(matches) ? items.map(item => matches(item) ? value : item) : [...items, value]
}

/** Shared presentation reducer; execution and persistence remain in the single Agent runtime. */
export function applyRunActivityEvent<T extends AgentRunActivity>(run: T, event: AgentRuntimeEvent): T {
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
      return event.delta.type === 'reasoning' ? { ...model, reasoning: model.reasoning + event.delta.text }
        : { ...model, text: model.text + event.delta.text }
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
