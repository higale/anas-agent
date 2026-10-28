import { isDeepStrictEqual } from 'node:util'
import type { AgentThreadSnapshot } from '../../shared/agentTypes'
import type { AppConfigSnapshot } from '../../shared/types'
import { isSubagentConfigured } from '../../shared/subagentSelection'
import { toolProvidedSummary } from '../../shared/agentActivity'
import { ToolInputError } from '../../runtime/errors'
import type { RunExecutionCommand } from '../../runtime/runExecution'
import type { NativeConversationDatabase } from './nativeConversationDatabase'
import type { NativeRunHost, NativeRunContext, NativeRunInstance } from './nativeRunHost'
import type { AgentSubagentCallRecord } from './subagentTaskStore'
import { maximumConcurrentSubagents, maximumSubagentDepth, type SubagentToolRuntime, type SubagentProcessSnapshot } from './subagentTools'
import { resolveSubagentModelSelection } from './modelSelection'
import { runtimeLog } from '../runtimeLogger'

type Owner = { threadId: string; runId: string }
const childOwner = (call: AgentSubagentCallRecord): Owner => ({ threadId: call.childThreadId, runId: call.childRunId })
const live = (call: AgentSubagentCallRecord) => call.status === 'running' || call.status === 'interrupted'

export interface NativeSubagentServices {
  create(call: AgentSubagentCallRecord, context: NativeRunContext): Promise<NativeRunInstance>
  configuration(): Promise<Pick<AppConfigSnapshot, 'providers' | 'defaultModel'>>
  snapshot(threadId: string): Promise<AgentThreadSnapshot>
}

/** The existing subagent tools consume this service directly. Hidden child
 * conversations use the same run host, durable store, configuration and events. */
export class NativeSubagentService {
  constructor(private readonly database: NativeConversationDatabase, private readonly host: NativeRunHost,
    private readonly services: NativeSubagentServices) {}

  private reconcile(call: AgentSubagentCallRecord): AgentSubagentCallRecord {
    if (!this.host.isActive(childOwner(call))) {
      const transition = this.database.runs.reconcileSubagent(call.id, call.ownerThreadId)
      if (transition) this.host.publishSubagent(transition.call, transition.activity)
    }
    return this.database.runs.subagents.require(call.id, call.ownerThreadId)
  }

  private launch(call: AgentSubagentCallRecord, command: RunExecutionCommand): void {
    const handle = this.host.start(childOwner(call), command, context => this.services.create(call, context))
    const report = (error: unknown) => {
      runtimeLog('warn', 'subagent', 'Native subagent execution could not settle.', { subagentId: call.id,
        error: error instanceof Error ? error.message : String(error) })
    }
    // The host publishes recoverable assembly errors and durable outcomes. These
    // handlers cover storage failures that prevent even reading that outcome.
    void handle.completed.catch(report)
    void handle.drained.catch(report)
  }

  private async ensureRunning(initial: AgentSubagentCallRecord): Promise<void> {
    if (this.host.isActive(childOwner(initial))) return
    const call = this.reconcile(initial)
    if (!live(call)) return
    const state = this.database.runs.store.load(call.childThreadId)
    if (call.status === 'interrupted') {
      // The UI snapshot suppresses requests already owned by saved responses.
      if (this.host.readSnapshot(call.childThreadId).interrupts.length) return
      this.launch(call, 'resume')
    } else this.launch(call, state?.runId === call.childRunId ? 'continue' : 'input')
  }

  private async snapshot(initial: AgentSubagentCallRecord): Promise<SubagentProcessSnapshot> {
    const call = this.reconcile(initial), activity = this.database.messages.activities.getRunProcessActivity(call.childRunId)
    const interrupts = call.status === 'interrupted' ? (await this.services.snapshot(call.childThreadId)).interrupts : []
    if (interrupts.length) {
      const durable = this.database.runs.readInterrupts(childOwner(call))
      if (durable.length !== interrupts.length || durable.some(item => !interrupts.some(visible => visible.id === item.id
        && visible.approvalGeneration === item.approvalGeneration && isDeepStrictEqual(visible.value, item.value)))) {
        throw new Error(`Subagent ${call.id} approval generation changed while it was read.`)
      }
    }
    const current = this.database.runs.subagents.require(call.id, call.ownerThreadId)
    if (current.status !== call.status || current.result !== call.result || current.error !== call.error) {
      throw new Error(`Subagent ${call.id} changed while its snapshot was read. Read it again.`)
    }
    return { call, modelRounds: activity.modelRounds, toolCalls: activity.toolCalls,
      activeTools: activity.activeTools.map(tool => ({ name: tool.call.name,
        ...(toolProvidedSummary(tool.call.args) ? { summary: toolProvidedSummary(tool.call.args) } : {}) })),
      ...(activity.latestModel?.text ? { latestText: activity.latestModel.text } : {}),
      ...(activity.latestModel?.reasoning ? { latestReasoning: activity.latestModel.reasoning } : {}),
      interrupts, ...(interrupts[0]?.approvalGeneration ? { approvalGeneration: interrupts[0].approvalGeneration } : {}) }
  }

  forRun(owner: Owner): SubagentToolRuntime {
    const thread = this.database.resources.getThread(owner.threadId), run = this.database.messages.activities.getRun(owner.runId)
    if (!thread || run?.threadId !== owner.threadId) throw new Error('The parent run does not belong to this conversation.')
    const parent = this.database.resources.getSubagentCallByChildThreadId(owner.threadId)
    if (parent && parent.childRunId !== owner.runId) throw new Error('The parent subagent does not own this run.')
    const ownerThreadId = parent?.ownerThreadId ?? owner.threadId
    const find = (id: string) => {
      const call = this.database.runs.subagents.find(id, ownerThreadId)
      return call?.parentRunId === owner.runId ? call : undefined
    }
    const requireOwned = (id: string) => {
      const call = find(id)
      if (!call) throw new ToolInputError(`Subagent ${id} was not found in this run. Use read_subagent without an ID to list this run's subagents.`)
      return call
    }
    const cancel = async (id: string, armEffect?: () => void) => {
      const call = this.reconcile(requireOwned(id)), identity = childOwner(call)
      if (live(call)) this.host.cancel(identity, armEffect)
      await this.host.getRunHandle(identity)?.completed
      return this.snapshot(requireOwned(id))
    }
    return {
      start: async (request, description, identity, armEffect) => {
        const existing = this.database.runs.subagents.find(identity.subagentId, ownerThreadId)
        if (existing) {
          if (existing.parentRunId !== owner.runId || existing.agentName !== request.agentName
            || existing.childThreadId !== identity.childThreadId || existing.childRunId !== identity.childRunId
            || existing.description !== description) throw new Error(`Subagent ${existing.id} durable start identity changed.`)
          this.host.publishSubagent(existing, this.database.runs.subagents.recordCallActivity(existing))
          await this.ensureRunning(existing)
          return this.snapshot(existing)
        }
        const config = request.config
        if (!config || !isSubagentConfigured(config) || config.name !== request.agentName) {
          throw new ToolInputError(`Configured subagent ${request.agentName} is unavailable. Choose an available agent listed in start_subagent.`)
        }
        const modelSelection = config.modelConfigId ? resolveSubagentModelSelection(config, await this.services.configuration()) : {}
        if (this.database.background.listDescendantSubagentCalls(ownerThreadId).filter(live).length >= maximumConcurrentSubagents) {
          throw new ToolInputError(`At most ${maximumConcurrentSubagents} subagents may be active in one conversation. Wait for an existing subagent to finish before starting another.`)
        }
        let depth = 1, ancestorId = parent?.id
        const seen = new Set<string>()
        while (ancestorId) {
          if (seen.has(ancestorId)) throw new Error('Subagent ancestry contains a cycle.')
          seen.add(ancestorId); depth++
          ancestorId = this.database.runs.subagents.require(ancestorId, ownerThreadId).parentSubagentId
        }
        if (depth > maximumSubagentDepth) throw new ToolInputError(`Subagent nesting is limited to ${maximumSubagentDepth} levels. Complete this work without further delegation.`)
        const call = this.database.runs.createSubagentCall({ id: identity.subagentId, ownerThreadId, parentThreadId: owner.threadId,
          parentRunId: owner.runId, parentSubagentId: parent?.id, childThreadId: identity.childThreadId, childRunId: identity.childRunId,
          config, description, childThread: { ...modelSelection, title: description.slice(0, 120), projectId: thread.projectId, accessMode: thread.accessMode } }, armEffect)
        this.host.publishSubagent(call, this.database.runs.subagents.recordCallActivity(call))
        this.launch(call, 'input')
        return this.snapshot(call)
      },
      read: async id => {
        const calls = id ? [requireOwned(id)] : this.database.resources.listUnresolvedSubagentCallsForRun(owner.runId)
        await Promise.all(calls.filter(live).map(call => this.ensureRunning(call)))
        const snapshots = await Promise.all(calls.map(call => this.snapshot(call)))
        return id ? snapshots[0] : snapshots
      },
      wait: async (id, timeoutMs, signal) => {
        const initial = requireOwned(id)
        await this.ensureRunning(initial)
        const before = await this.snapshot(initial)
        if (before.call.status !== 'running' || initial.status !== before.call.status || initial.result !== before.call.result || initial.error !== before.call.error) return before
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) { reject(signal.reason ?? new Error('Subagent wait was cancelled.')); return }
          let unsubscribe = () => {}
          const finish = (aborted = false) => {
            clearTimeout(timeout)
            unsubscribe(); signal?.removeEventListener('abort', abort)
            if (aborted) reject(signal?.reason ?? new Error('Subagent wait was cancelled.'))
            else resolve()
          }
          const abort = () => finish(true)
          unsubscribe = this.host.subscribe(event => {
            const runId = 'run' in event ? event.run.id : event.runId
            if (runId === initial.childRunId && ['run_completed', 'run_interrupted', 'run_failed', 'run_cancelled', 'run_recovery_failed', 'run_settled'].includes(event.type)) finish()
          })
          const timeout = setTimeout(() => finish(), timeoutMs)
          signal?.addEventListener('abort', abort, { once: true })
          const current = requireOwned(id)
          if (current.status !== before.call.status || current.result !== before.call.result || current.error !== before.call.error
            || !this.host.isActive(childOwner(current))) finish()
        })
        return this.snapshot(requireOwned(id))
      },
      cancel: (id, armEffect) => cancel(id, armEffect),
      resume: async (id, responses) => {
        const call = requireOwned(id)
        await this.host.getRunHandle(childOwner(call))?.drained
        this.database.runs.saveResponses({ ...childOwner(call), responses })
        this.launch(requireOwned(id), 'resume')
      },
      unresolvedForRun: limit => this.database.resources.listUnresolvedSubagentCallsForRun(owner.runId, limit),
      resolveObserved: id => { requireOwned(id); this.database.runs.subagents.resolve(id, ownerThreadId, owner.runId) },
      cancelRun: async () => {
        const outcomes = await Promise.allSettled(this.database.resources.listSubagentCallsForParentRun(owner.runId).filter(live).map(call => cancel(call.id)))
        const failures = outcomes.filter(result => result.status === 'rejected').map(result => result.reason)
        if (failures.length) throw new AggregateError(failures, 'Failed to cancel native subagents.')
      }
    }
  }
}
