import type Database from 'better-sqlite3'
import type { AgentModelActivity, AgentToolActivity, AgentSubagentActivity, AgentToolCall, AgentToolApproval, AgentRuntimeEvent } from '../../shared/agentTypes'
import type { SubagentTaskStore, AgentSubagentCallRecord } from './subagentTaskStore'
import type { RunActivityObservations } from './runActivityObservations'
import type { RunActivityReader } from './runActivityReader'
import type { RunActivityProjection } from './runActivityProjection'

function toolActivityKey(callId: string, subagentId: string): string { return `tool:${subagentId}:${callId}` }

/** Child observations share their durable owner and project to every ancestor.
 * Lifecycle transitions remain the execution owner's responsibility. */
export class SubagentActivityProjection {
  constructor(private readonly database: Database.Database, private readonly subagents: SubagentTaskStore,
    private readonly observations: RunActivityObservations, private readonly reader: RunActivityReader,
    private readonly activity: RunActivityProjection) {}

  projectEvent(call: AgentSubagentCallRecord, event: AgentRuntimeEvent): AgentRuntimeEvent | undefined {
    if (event.type === 'model_started' || event.type === 'model_completed') {
      const subagentId = event.model.subagentId ?? call.id
      const model = subagentId === call.id
        ? this.recordProjectedModelActivity(call.id, call.ownerThreadId, {
            ...event.model,
            subagentId
          })
        : this.requireProjectedModelActivity(call, event.model.id, subagentId)
      return { ...event, runId: call.parentRunId, threadId: call.parentThreadId, model }
    }
    if (event.type === 'model_delta' || event.type === 'model_tool_calls') {
      const projected = {
        ...event,
        runId: call.parentRunId,
        threadId: call.parentThreadId,
        subagentId: event.subagentId ?? call.id
      }
      if (projected.type === 'model_tool_calls') this.activity.rememberToolCallProgress(projected)
      return projected
    }
    if (event.type === 'tool_started' || event.type === 'tool_completed') {
      const subagentId = event.subagentId ?? call.id
      const tool = subagentId === call.id
        ? this.recordProjectedToolActivity(
            call.id,
            call.ownerThreadId,
            event.call,
            event.type === 'tool_completed' ? 'completed' : 'running',
            subagentId,
            event.type === 'tool_completed' ? event.output : undefined
          )
        : this.requireProjectedToolActivity(call, event.call.id, subagentId)
      return {
        ...event,
        runId: call.parentRunId,
        threadId: call.parentThreadId,
        sequence: tool.sequence,
        subagentId
      }
    }
    if (event.type === 'tool_approval_requested') {
      const subagentId = event.subagentId ?? call.id
      const tool = subagentId === call.id
        ? this.recordProjectedToolApproval(
            call.id,
            call.ownerThreadId,
            event.call,
            event.approval,
            subagentId
          )
        : this.requireProjectedToolActivity(call, event.call.id, subagentId)
      return {
        ...event,
        runId: call.parentRunId,
        threadId: call.parentThreadId,
        sequence: tool.sequence,
        subagentId,
        startedAt: tool.startedAt
      }
    }
    if (event.type === 'subagent_updated') {
      const nested = event.subagent.id === call.id
        ? this.subagents.project(
            call.id,
            call.ownerThreadId,
            {
              ...event.subagent,
              parentSubagentId: event.subagent.parentSubagentId ?? call.id
            }
          )
        : this.requireProjectedSubagentActivity(call, event.subagent.id)
      return {
        type: 'subagent_updated',
        runId: call.parentRunId,
        threadId: call.parentThreadId,
        subagent: nested
      }
    }
    return undefined
  }

  recordProjectedModelActivity(
    carrierSubagentId: string,
    ownerThreadId: string,
    model: Omit<AgentModelActivity, 'sequence' | 'startedAt' | 'completedAt'> & {
      subagentId: string
    }
  ): AgentModelActivity {
    const carrier = this.subagents.require(carrierSubagentId, ownerThreadId)
    this.subagents.requireDescendant(carrier, model.subagentId)
    const project = this.database.transaction(() => {
      let direct: AgentModelActivity | undefined
      for (const [index, ancestor] of this.subagents.chain(carrier).entries()) {
        const recorded = this.observations.recordModel(ancestor.parentRunId, model)
        if (index === 0) direct = recorded
        else if (direct) {
          this.alignProjectedActivityTiming(
            ancestor.parentRunId,
            `model:${model.id}`,
            direct
          )
        }
      }
      if (!direct) throw new Error(`Subagent ${carrierSubagentId} has no projection target.`)
      return direct
    })
    return project()
  }

  recordProjectedToolActivity(
    carrierSubagentId: string,
    ownerThreadId: string,
    call: AgentToolCall,
    status: 'running' | 'completed',
    projectedSubagentId: string,
    output?: unknown
  ): AgentToolActivity {
    const carrier = this.subagents.require(carrierSubagentId, ownerThreadId)
    this.subagents.requireDescendant(carrier, projectedSubagentId)
    const project = this.database.transaction(() => {
      let direct: AgentToolActivity | undefined
      for (const [index, ancestor] of this.subagents.chain(carrier).entries()) {
        const recorded = this.observations.recordTool(
          ancestor.parentRunId,
          call,
          status,
          projectedSubagentId,
          output
        )
        if (index === 0) direct = recorded
        else if (direct) {
          this.alignProjectedActivityTiming(
            ancestor.parentRunId,
            toolActivityKey(call.id, projectedSubagentId),
            direct
          )
        }
      }
      if (!direct) throw new Error(`Subagent ${carrierSubagentId} has no projection target.`)
      return direct
    })
    return project()
  }

  recordProjectedToolApproval(
    carrierSubagentId: string,
    ownerThreadId: string,
    call: AgentToolCall,
    approval: AgentToolApproval,
    projectedSubagentId: string
  ): AgentToolActivity {
    const carrier = this.subagents.require(carrierSubagentId, ownerThreadId)
    this.subagents.requireDescendant(carrier, projectedSubagentId)
    const project = this.database.transaction(() => {
      let direct: AgentToolActivity | undefined
      for (const [index, ancestor] of this.subagents.chain(carrier).entries()) {
        const recorded = this.observations.recordTool(
          ancestor.parentRunId,
          call,
          'running',
          projectedSubagentId
        )
        this.observations.recordToolApproval(
          ancestor.parentRunId,
          call.id,
          approval,
          projectedSubagentId
        )
        if (index === 0) direct = recorded
        else if (direct) {
          this.alignProjectedActivityTiming(
            ancestor.parentRunId,
            toolActivityKey(call.id, projectedSubagentId),
            direct
          )
        }
      }
      if (!direct) throw new Error(`Subagent ${carrierSubagentId} has no projection target.`)
      return { ...direct, approval }
    })
    return project()
  }

  private alignProjectedActivityTiming(
    runId: string,
    activityKey: string,
    source: { startedAt?: string; completedAt?: string }
  ): void {
    if (!source.startedAt) return
    this.database.prepare(`
      UPDATE agent_activity_timing
      SET started_at = ?, completed_at = ?
      WHERE run_id = ? AND activity_key = ?
    `).run(source.startedAt, source.completedAt ?? null, runId, activityKey)
  }

  private requireProjectedModelActivity(
    call: AgentSubagentCallRecord,
    modelId: string,
    subagentId: string
  ): AgentModelActivity {
    const model = this.reader.getModelActivity(call.parentRunId, modelId)
    if (!model || model.subagentId !== subagentId) {
      throw new Error(`Model activity ${modelId} was not projected for subagent ${subagentId}.`)
    }
    return model
  }

  private requireProjectedToolActivity(
    call: AgentSubagentCallRecord,
    callId: string,
    subagentId: string
  ): AgentToolActivity {
    const tool = this.reader.getToolActivity(call.parentRunId, callId, subagentId)
    if (!tool) {
      throw new Error(`Tool activity ${callId} was not projected for subagent ${subagentId}.`)
    }
    return tool
  }

  private requireProjectedSubagentActivity(
    call: AgentSubagentCallRecord,
    subagentId: string
  ): AgentSubagentActivity {
    const subagent = this.reader.getSubagentActivity(call.parentRunId, subagentId)
    if (!subagent) {
      throw new Error(`Subagent activity ${subagentId} was not projected for run ${call.parentRunId}.`)
    }
    return subagent
  }

}
