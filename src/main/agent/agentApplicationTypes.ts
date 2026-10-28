import type { AgentRun, AgentThread, AgentSubagentActivity } from '../../shared/agentTypes'
import type { FileChangeLedger } from './fileChangeLedger'

/** Product reads used by chat, panels and fixed-scope review. No executor,
 * execution state or mutable connection escapes this boundary. */
export interface AgentApplicationReadModel {
  readonly fileChanges: FileChangeLedger
  getThread(threadId: string): AgentThread | null
  getRun(runId: string): AgentRun | null
  getSubagentActivity(runId: string, subagentId: string): AgentSubagentActivity | undefined
}
