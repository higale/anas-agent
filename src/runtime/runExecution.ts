import type { AgentToolCall, AgentToolApproval } from '../shared/agentTypes'
import type { ModelRunObservation } from './modelEvents'
import type { ToolRunObservation } from './toolEvents'

export interface RunToolApproval {
  call: AgentToolCall
  approval: AgentToolApproval
  subagentId?: string
}

/** Facts observed after a durable commit, never a second execution state. */
export interface RunCommitFacts {
  messageIds: string[]
  summary?: { id: string; modelContent: string; cutoffIndex: number }
}

export interface RunCommitObservation extends RunCommitFacts {
  commitId: string
}

/** Durable progress supplied to the owning store in its commit transaction.
 * Markers acknowledge only the matching run's already-saved input intent. */
export interface RunProgressCommit {
  threadId: string
  commitId: string
  inputRunIds: readonly string[]
  completedRunId?: string
  summary?: RunCommitFacts['summary']
}

/** Application observations, not execution authority. A failed observer must
 * not downgrade a committed run or skip draining already entered operations. */
export interface RunObserver {
  started(): void
  startModel(subagentId?: string, recovery?: import('../shared/modelRecovery').ModelRecoveryState): string
  discardModel(id: string): void
  model(event: ModelRunObservation): void
  tool(event: ToolRunObservation): void
  approval(activity: RunToolApproval): void
  committed(commit: RunCommitObservation): Promise<void>
}

export interface RunExecutionResult {
  result: PromiseSettledResult<unknown>
  interrupted: boolean
  observationErrors: unknown[]
}

/** Commands refer to intents already saved for this run; callers cannot pass
 * an uncommitted input or approval payload into execution. */
export type RunExecutionCommand = 'input' | 'resume' | 'continue'

/** Returned values use the application execution contract.
 * No stream classes, graph config or task protocol escape. */
export interface RunExecution {
  execute(command: RunExecutionCommand, request: { threadId: string; runId: string; signal: AbortSignal },
    observer: RunObserver): Promise<RunExecutionResult>
}
