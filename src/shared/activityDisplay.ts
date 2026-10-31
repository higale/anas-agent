import type { AgentMessage, AgentRunActivity, AgentThreadSnapshot, AgentModelActivity, AgentToolActivity, AgentActivityDetailReference, AgentRuntimeEvent } from './agentTypes'
import { agentModelReplyDisposition } from './agentReplyLifecycle'

export const activityInitialSize = 300
export const activityPageSize = 100
export const activityWindowLimit = 500
// Copy the small prefix: V8 sliced strings can otherwise retain a huge body.
const caption = (value: string | undefined) => value === undefined ? undefined : [...value.slice(0, 240)].join('')
function toolCaption(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  const record = args as Record<string, unknown>
  for (const key of ['summary', 'description', 'path', 'url', 'query', 'command']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return caption(value)?.replace(/\s+/g, ' ').trim()
  }
  return undefined
}

export function activityReference(threadId: string, runId: string, kind: AgentActivityDetailReference['kind'], id: string, subagentId?: string): AgentActivityDetailReference {
  return { threadId, runId, kind, id, ...(subagentId ? { subagentId } : {}) }
}

export function displayModel(threadId: string, runId: string, model: AgentModelActivity): AgentModelActivity {
  return { ...model, text: '', reasoning: '', hasText: model.hasText || Boolean(model.text),
    hasReasoning: model.hasReasoning || Boolean(model.reasoning), reasoningSummary: caption(model.reasoningSummary),
    detail: activityReference(threadId, runId, 'model', model.id, model.subagentId) }
}

export function displayTool(threadId: string, runId: string, tool: AgentToolActivity): AgentToolActivity {
  if (tool.detail) return tool
  const args = tool.call.args as Record<string, unknown> | null
  let output = tool.output
  if (tool.call.name === 'start_subagent' && typeof output === 'string') { try { output = JSON.parse(output) } catch { output = undefined } }
  const childId = tool.call.name === 'start_subagent' && output && typeof output === 'object' && 'subagent_id' in output
    && typeof output.subagent_id === 'string' ? output.subagent_id : undefined
  return { ...tool, call: { ...tool.call, args: { summary: toolCaption(args),
    ...(typeof args?.seconds === 'number' ? { seconds: args.seconds } : {}),
    ...(typeof args?.description === 'string' ? { description: caption(args.description) } : {}) } },
    output: childId ? { subagent_id: childId } : undefined,
    freeform: tool.call.name === 'apply_patch' && !!args && Object.keys(args).length === 1 && typeof args.input === 'string',
    detail: activityReference(threadId, runId, 'tool', tool.call.id, tool.subagentId) }
}

/** Transport projection only. Never pass these records to execution or persistence. */
export function displayActivityPage(threadId: string, run: AgentRunActivity): AgentRunActivity {
  return { ...run,
    models: run.models.map(model => displayModel(threadId, run.runId, model)),
    tools: run.tools.map(tool => displayTool(threadId, run.runId, tool)),
    subagents: run.subagents.map(item => ({ ...item, delegation: item.delegation && displayTool(threadId, run.runId, item.delegation), result: undefined, error: caption(item.error), detailsDeferred: true,
      detail: activityReference(threadId, run.runId, 'subagent', item.id) })),
    summaries: run.summaries?.map(item => ({ ...item, summaryText: '', detail: activityReference(threadId, run.runId, 'summary', item.id) })),
    memoryRecalls: run.memoryRecalls?.map(item => ({ ...item, query: '', promptText: '', detail: activityReference(threadId, run.runId, 'memory', item.id) })) }
}

export function displayMessage(threadId: string, message: AgentMessage): AgentMessage {
  return { ...message, content: message.content.filter(block => block.type !== 'reasoning'),
    ...(message.skillInvocation && message.runId ? { skillInvocation: { ...message.skillInvocation, promptText: '',
      detail: activityReference(threadId, message.runId, 'skill', message.id) } } : {}) }
}

export function displaySnapshot(snapshot: AgentThreadSnapshot): AgentThreadSnapshot {
  return { ...snapshot, messages: snapshot.messages.map(message => displayMessage(snapshot.thread.id, message)),
    activities: snapshot.activities.map(run => displayRunSummary(snapshot.thread.id, run)) }
}

export function displayRunSummary(threadId: string, run: AgentRunActivity): AgentRunActivity {
      const lean = displayActivityPage(threadId, run)
      const active = run.status === 'running' || run.status === 'interrupted'
      const final = run.models.find(model => agentModelReplyDisposition(run, model) === 'final')
      return { ...lean, display: run.display ?? { modelCount: run.models.filter(m => !m.subagentId).length,
        toolCount: run.tools.filter(t => !t.subagentId).length, subagentCount: run.subagents.filter(s => !s.parentSubagentId).length,
        lastSequence: Math.max(-1, ...run.models.map(m => m.sequence), ...run.tools.map(t => t.sequence), ...run.subagents.map(s => s.sequence)),
        finalMessageId: run.status === 'completed' ? final?.messageId : undefined },
        models: active ? lean.models.filter(m => m.status === 'running').slice(-activityWindowLimit) : [],
        tools: active ? lean.tools.filter(t => t.status === 'running').slice(-activityWindowLimit) : [],
        memoryRecalls: [], subagents: lean.subagents.filter(s => s.status === 'running' || s.status === 'interrupted') }
}

/** Replay needs identities and invalidations; bodies are read from their owner. */
export function displayEvent(event: AgentRuntimeEvent): AgentRuntimeEvent {
  if (event.type === 'run_started' && event.userMessage) return { ...event, userMessage: displayMessage(event.run.threadId, event.userMessage) }
  if ('snapshot' in event && event.snapshot) return { ...event, snapshot: displaySnapshot(event.snapshot) }
  if (event.type === 'model_started' || event.type === 'model_completed') return { ...event, model: displayModel(event.threadId, event.runId, event.model) }
  if (event.type === 'model_delta') return { ...event, delta: { ...event.delta, text: '' } }
  if (event.type === 'tool_started' || event.type === 'tool_completed' || event.type === 'tool_approval_requested') {
    const tool = displayTool(event.threadId, event.runId, { ...event, status: event.type === 'tool_completed' ? 'completed' : 'running' })
    return { ...event, call: tool.call, ...('output' in event ? { output: tool.output } : {}) }
  }
  if (event.type === 'subagent_updated') return { ...event, subagent: { ...event.subagent, delegation: event.subagent.delegation && displayTool(event.threadId, event.runId, event.subagent.delegation), result: undefined,
    error: caption(event.subagent.error), detailsDeferred: true, detail: activityReference(event.threadId, event.runId, 'subagent', event.subagent.id) } }
  if (event.type === 'memory_recalled') return { ...event, recall: { ...event.recall, query: '', promptText: '',
    detail: activityReference(event.threadId, event.runId, 'memory', event.recall.id) } }
  if (event.type === 'context_compression_started' || event.type === 'context_compression_completed') return { ...event, summary: { ...event.summary, summaryText: '',
    detail: activityReference(event.threadId, event.runId, 'summary', event.summary.id) } }
  return event
}

export function boundedDisplayRun<T extends AgentRunActivity>(threadId: string, run: T): T {
  const lean = displayActivityPage(threadId, run)
  const sequences = [...lean.models, ...lean.tools, ...lean.subagents, ...(lean.summaries ?? []), ...(lean.memoryRecalls ?? [])]
    .map(item => item.sequence).sort((a, b) => b - a)
  const cutoff = sequences[activityWindowLimit - 1] ?? -1
  return { ...run, ...lean, display: run.display ?? { modelCount: run.models.length, toolCount: run.tools.length, subagentCount: run.subagents.length, lastSequence: Math.max(-1, ...sequences) },
    models: lean.models.filter(m => m.sequence >= cutoff), tools: lean.tools.filter(t => t.sequence >= cutoff),
    subagents: lean.subagents.filter(s => s.sequence >= cutoff || s.status === 'running' || s.status === 'interrupted'),
    summaries: lean.summaries?.filter(s => s.sequence >= cutoff), memoryRecalls: lean.memoryRecalls?.filter(m => m.sequence >= cutoff) }
}
