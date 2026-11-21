import { z } from 'zod'

export const processIdentitySchema = z.object({
  pid: z.number().int().min(2), birth: z.string().min(1), name: z.string(),
  startedAt: z.string(), parentPid: z.number().int().nonnegative(),
  role: z.enum(['shell', 'child'])
})
export type ProcessIdentity = z.infer<typeof processIdentitySchema>
export type ObservedProcess = ProcessIdentity & { status: 'running' | 'exited' | 'unknown' }
export interface ProcessSnapshot {
  processes: ObservedProcess[]
  /** Sampling cannot prove that no descendant escaped observation. */
  complete: false
  checkedAt: string
  error?: string
}

/** Compact tool-facing observation; full identities stay in the process list. */
export function processSnapshotSummary(snapshot?: ProcessSnapshot): {
  remaining_processes?: { pid: number; name: string }[]
  process_observation_error?: string
} {
  const remaining = snapshot?.processes.filter(info => info.role === 'child' && info.status === 'running')
    .map(({ pid, name }) => ({ pid, name })) ?? []
  return {
    ...(remaining.length ? { remaining_processes: remaining } : {}),
    ...(snapshot?.error ? { process_observation_error: snapshot.error } : {})
  }
}
export interface ProcessCallGroup {
  callId: string; threadId: string; runId: string; summary: string; command: string
  status: string; createdAt: string; snapshot: ProcessSnapshot
}
export interface ProcessListPage { calls: ProcessCallGroup[]; nextCursor?: string }
export interface ProcessListApi {
  list(input: { threadId: string; cursor?: string }): Promise<ProcessListPage>
  terminate(input: { threadId: string; callId: string; process: ProcessIdentity }): Promise<void>
}
