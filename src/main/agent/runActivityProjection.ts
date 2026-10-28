import { createHash, randomUUID } from 'node:crypto'
import type { AgentRuntimeEvent, AgentThreadSnapshot, AgentRunActivity, AgentToolCall, AgentMemoryRecall, AgentContextStatus } from '../../shared/agentTypes'
import type { ModelRunObservation } from '../../runtime/modelEvents'
import type { ToolRunObservation } from '../../runtime/toolEvents'
import type { RunObserver, RunToolApproval, RunCommitFacts } from '../../runtime/runExecution'
import { traceText, traceReasoningSummary } from '../../runtime/messagePresentation'
import { runtimeLog } from '../runtimeLogger'
import type { RunActivityReader } from './runActivityReader'
import type { RunActivityObservations } from './runActivityObservations'
import { createCompressionTracking, type ContextSummaryStore } from './contextSummaryStore'

export interface RunEventSink { push(event: AgentRuntimeEvent): void }

export function stateTodos(values: unknown): AgentThreadSnapshot['todos'] {
  if (!values || typeof values !== 'object') return []
  const todos = (values as { todos?: unknown }).todos
  if (!Array.isArray(todos)) return []
  return todos.flatMap((todo) => {
    if (!todo || typeof todo !== 'object') return []
    const item = todo as { content?: unknown; status?: unknown }
    if (typeof item.content !== 'string') return []
    if (item.status !== 'pending' && item.status !== 'in_progress' && item.status !== 'completed') return []
    return [{ content: item.content, status: item.status }]
  })
}

function toolInputTodos(name: string, input: unknown): AgentThreadSnapshot['todos'] | undefined {
  if (name !== 'write_todos' || !input || typeof input !== 'object') return undefined
  const candidate = (input as { todos?: unknown }).todos
  if (!Array.isArray(candidate)) return undefined
  const todos = stateTodos({ todos: candidate })
  return todos.length === candidate.length ? todos : undefined
}


/** Existing renderer events and transient progress. No execution decisions are
 * made here; committed message ownership remains in the conversation store. */
export class RunActivityProjection {
  private readonly publishedContextSummaries = new Map<string, Set<string>>()
  private readonly publishedToolCompletions = new Map<string, Set<string>>()
  private readonly toolCallProgress = new Map<string, Map<string, Extract<AgentRuntimeEvent, { type: 'model_tool_calls' }>>>()
  constructor(private readonly reader: RunActivityReader, private readonly observations: RunActivityObservations,
    private readonly summaries: ContextSummaryStore) {}

  contextCallbacks(runId: string, threadId: string, queue: RunEventSink) {
    return {
      ...createCompressionTracking(this.summaries, runId, {
        started: summary => queue.push({ type: 'context_compression_started', runId, threadId, summary }),
        discarded: summaryId => queue.push({ type: 'context_compression_discarded', runId, threadId, summaryId })
      }),
      onContextStatus: (status: AgentContextStatus) => {
        this.observations.recordContextStatus(threadId, status)
        queue.push({ type: 'context_status_updated', runId, threadId, status })
      },
      onMemoryRecall: (details: Pick<AgentMemoryRecall, 'query' | 'promptText' | 'memoryCount' | 'agentName'>) => {
        const id = createHash('sha256').update(JSON.stringify([
          details.agentName ?? '', details.query, details.promptText, details.memoryCount
        ])).digest('hex')
        const recall = this.observations.recordMemoryRecall(runId, { id, ...details })
        queue.push({ type: 'memory_recalled', runId, threadId, recall })
      }
    }
  }

  publishCommittedContextSummary(runId: string, threadId: string, summary: RunCommitFacts['summary'], queue: RunEventSink): void {
    const id = summary?.id
    if (!id) return
    const published = this.publishedContextSummaries.get(runId) ?? new Set<string>()
    if (published.has(id)) return
    const committed = this.summaries.getCommittedContextSummary(runId, id)
    if (!committed || committed.modelContent !== summary.modelContent || committed.cutoffIndex !== summary.cutoffIndex) return
    const sequence = committed.firstPreservedMessageId
      ? this.reader.getMessageActivitySequence(committed.runId, committed.firstPreservedMessageId) : undefined
    queue.push({ type: 'context_compression_completed', runId, threadId,
      summary: sequence === undefined ? committed : { ...committed, firstPreservedActivitySequence: sequence } })
    published.add(id)
    this.publishedContextSummaries.set(runId, published)
  }

  startModel(runId: string, threadId: string, queue: RunEventSink, subagentId?: string): string {
    const id = randomUUID()
    const model = this.observations.recordModel(runId, { id, status: 'running', subagentId, text: '', reasoning: '', toolCallIds: [] })
    queue.push({ type: 'model_started', runId, threadId, model })
    return id
  }

  observer(runId: string, threadId: string, queue: RunEventSink, hooks: Partial<Pick<RunObserver, 'started' | 'committed'>> = {}): RunObserver {
    return {
      started: () => hooks.started?.(), startModel: subagentId => this.startModel(runId, threadId, queue, subagentId),
      discardModel: id => { this.observations.discardModel(runId, id) },
      model: event => this.observeModelRun(event, runId, threadId, queue),
      tool: event => this.observeToolRun(event, runId, threadId, queue),
      approval: activity => this.recordInterruptedToolActivity(runId, threadId, activity, queue),
      committed: async commit => {
        this.reconcileRootToolActivities(runId, threadId, queue)
        this.publishCommittedContextSummary(runId, threadId, commit.summary, queue)
        await hooks.committed?.(commit)
      }
    }
  }

  releaseRun(runId: string): void {
    this.publishedContextSummaries.delete(runId)
    this.publishedToolCompletions.delete(runId)
    this.toolCallProgress.delete(runId)
    this.observations.releaseRun(runId)
  }

  decorate(activity: AgentRunActivity): AgentRunActivity {
    const progress = this.toolCallProgress.get(activity.runId)
    if (!progress) return activity
    return {
      ...activity,
      models: activity.models.map((model) => ({
        ...model,
        toolCallProgress: progress.get(JSON.stringify([model.subagentId, model.id]))?.progress
      }))
    }
  }


  observeModelRun(event: ModelRunObservation, runId: string, threadId: string, queue: RunEventSink): void {
    const { modelId: id, subagentId } = event
    if (event.kind === 'delta') {
      queue.push({ type: 'model_delta', runId, threadId, modelId: id, subagentId,
        delta: { type: event.channel, text: event.text } })
    } else if (event.kind === 'tool_input') {
      const progress: Extract<AgentRuntimeEvent, { type: 'model_tool_calls' }> = {
        type: 'model_tool_calls', runId, threadId, modelId: id, subagentId, progress: event.progress
      }
      this.rememberToolCallProgress(progress)
      queue.push(progress)
    } else if (event.kind === 'incomplete') {
      this.observations.recordModel(runId, { id, status: 'running', subagentId,
        text: '', reasoning: '', toolCallIds: [] })
    } else {
      runtimeLog('debug', 'agent', 'Model response metadata.', {
        runId, threadId, modelId: id, subagentId, usage: event.usage, responseMetadata: event.responseMetadata
      })
      const model = this.observations.recordModel(runId, {
        id, messageId: event.message.id, status: 'completed', subagentId,
        text: traceText(event.message.content, 'text') || event.streamedText,
        reasoning: traceText(event.message.content, 'reasoning') || event.streamedReasoning,
        reasoningSummary: traceReasoningSummary(event.message.content), toolCallIds: event.calls.map(call => call.id)
      })
      queue.push({ type: 'model_completed', runId, threadId, model })
      for (const call of event.calls) this.ensureToolActivity(runId, threadId, call, queue, subagentId)
    }
  }

  rememberToolCallProgress(event: Extract<AgentRuntimeEvent, { type: 'model_tool_calls' }>): void {
    const key = JSON.stringify([event.subagentId, event.modelId])
    const progress = this.toolCallProgress.get(event.runId) ?? new Map()
    if (event.progress.length) progress.set(key, event)
    else progress.delete(key)
    if (progress.size) this.toolCallProgress.set(event.runId, progress)
    else this.toolCallProgress.delete(event.runId)
  }

  private ensureToolActivity(
    runId: string,
    threadId: string,
    call: AgentToolCall,
    queue: RunEventSink,
    subagentId?: string
  ): AgentRunActivity['tools'][number] {
    const exact = this.reader.getToolActivity(runId, call.id, subagentId)
    if (exact) return exact
    const started = this.observations.recordTool(runId, call, 'running', subagentId)
    queue.push({
      type: 'tool_started',
      runId,
      threadId,
      call,
      sequence: started.sequence,
      subagentId,
      startedAt: started.startedAt
    })
    return started
  }

  recordInterruptedToolActivity(
    runId: string,
    threadId: string,
    interrupted: RunToolApproval,
    queue: RunEventSink
  ): void {
    const activity = this.ensureToolActivity(
      runId,
      threadId,
      interrupted.call,
      queue,
      interrupted.subagentId
    )
    this.observations.recordToolApproval(
      runId,
      interrupted.call.id,
      interrupted.approval,
      interrupted.subagentId
    )
    queue.push({
      type: 'tool_approval_requested',
      runId,
      threadId,
      call: interrupted.call,
      approval: interrupted.approval,
      sequence: activity.sequence,
      subagentId: interrupted.subagentId,
      startedAt: activity.startedAt
    })
  }

  reconcileRootToolActivities(runId: string, threadId: string, queue: RunEventSink): void {
    const published = this.publishedToolCompletions.get(runId)
    for (const callId of this.reader.listRootToolActivityIds(runId, 'completed')) {
      if (published?.has(JSON.stringify([null, callId]))) continue
      const completed = this.reader.getToolActivity(runId, callId)
      if (!completed) continue
      this.publishToolCompletion(queue, {
        type: 'tool_completed', runId, threadId, call: completed.call,
        sequence: completed.sequence, output: completed.output,
        startedAt: completed.startedAt, completedAt: completed.completedAt
      })
    }
  }

  observeToolRun(event: ToolRunObservation, runId: string, threadId: string, queue: RunEventSink): void {
    const { call, subagentId } = event
    if (event.kind === 'started') {
      const activity = this.ensureToolActivity(runId, threadId, call, queue, subagentId)
      if (activity.approval) {
        this.observations.clearToolApproval(runId, call.id, subagentId)
        queue.push({ type: 'tool_started', runId, threadId, call,
          sequence: activity.sequence, subagentId, startedAt: activity.startedAt })
      }
      return
    }
    const current = this.reader.getToolActivity(runId, call.id, subagentId)
    const completed = current?.status === 'completed' ? current : this.observations.recordTool(
      runId, call, 'completed', subagentId, event.output)
    this.publishToolCompletion(queue, {
      type: 'tool_completed', runId, threadId, call, sequence: completed.sequence,
      output: event.output, subagentId, startedAt: completed.startedAt, completedAt: completed.completedAt
    })
    if (!subagentId && event.succeeded) {
      const todos = toolInputTodos(call.name, call.args)
      if (todos) queue.push({ type: 'todos_updated', runId, threadId, todos })
    }
  }

  private publishToolCompletion(
    queue: RunEventSink,
    event: Extract<AgentRuntimeEvent, { type: 'tool_completed' }>
  ): void {
    const published = this.publishedToolCompletions.get(event.runId) ?? new Set<string>()
    const key = JSON.stringify([event.subagentId ?? null, event.call.id])
    if (published.has(key)) return
    published.add(key)
    this.publishedToolCompletions.set(event.runId, published)
    queue.push(event)
  }

}
