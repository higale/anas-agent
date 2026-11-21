import { processIdentitySchema, type ProcessIdentity, type ProcessListPage, type ProcessSnapshot } from '@shared/processes'
import { refreshProcesses, terminateObservedProcess } from '../processObservation'
import type { NativeConversationDatabase } from './nativeConversationDatabase'
import type { AgentManagedCallRecord } from './managedCallStore'

function identities(call: AgentManagedCallRecord): ProcessIdentity[] {
  const snapshot = call.outcome?.process_snapshot as Partial<ProcessSnapshot> | undefined
  if (!Array.isArray(snapshot?.processes)) return []
  return snapshot.processes.slice(0, 512).flatMap(value => {
    const parsed = processIdentitySchema.safeParse(value)
    return parsed.success ? [parsed.data] : []
  })
}

export function observeCallProcesses(call: AgentManagedCallRecord): ProcessSnapshot {
  return refreshProcesses(identities(call))
}

export function listConversationProcesses(database: NativeConversationDatabase, threadId: string, cursor?: string): ProcessListPage {
  if (!database.resources.getThread(threadId)) throw new Error('Conversation was not found.')
  const rows = database.managed.listProcessCalls(threadId, cursor)
  const calls = rows.slice(0, 100).map(call => {
    const snapshot = observeCallProcesses(call)
    const previous = call.outcome?.process_snapshot as ProcessSnapshot | undefined
    if (!['preparing', 'running'].includes(call.status) && previous && !snapshot.error
      && JSON.stringify([snapshot.processes, snapshot.error]) !== JSON.stringify([previous?.processes, previous?.error])) {
      database.managed.updateManagedCallOutcome(call.id, call.threadId, { ...call.outcome, process_snapshot: snapshot })
    }
    return { callId: call.id, threadId: call.threadId, runId: call.runId,
      summary: call.summary, command: typeof call.outcome?.command === 'string' ? call.outcome.command : call.summary,
      status: call.status, createdAt: call.createdAt, snapshot }
  })
  return { calls, ...(rows.length > 100 ? { nextCursor: rows[99].id } : {}) }
}
export function terminateConversationProcess(database: NativeConversationDatabase,
  input: { threadId: string; callId: string; process: ProcessIdentity }): void {
  const threads = [input.threadId, ...database.background.listDescendantSubagentCalls(input.threadId).map(call => call.childThreadId)]
  const call = threads.map(id => database.managed.getManagedCall(input.callId, id)).find(Boolean)
  if (!call || call.kind !== 'shell') throw new Error('The process call does not belong to this conversation.')
  const target = observeCallProcesses(call).processes.find(info => info.pid === input.process.pid && info.birth === input.process.birth)
  if (!target) throw new Error('The process is no longer associated with this call. Refresh the list.')
  terminateObservedProcess(processIdentitySchema.parse(target))
}
