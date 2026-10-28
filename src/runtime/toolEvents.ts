import type { AgentToolCall } from '../shared/agentTypes'

/** Timeline observations only. Effect confirmation and recovery still come from
 * the journal and committed conversation, not from transport stream status. */
export type ToolRunObservation = { call: AgentToolCall; subagentId?: string } & (
  | { kind: 'started' }
  | { kind: 'settled'; output: unknown; succeeded: boolean }
)

/** Track entered operations and their observations until cleanup finishes.
 * This scope never schedules, authorizes or persists an operation. */
export class ToolRunScope {
  private current?: { observe(event: ToolRunObservation): void; errors: unknown[] }
  private pending = new Set<Promise<void>>()

  track<T>(operation: Promise<T>): Promise<T> {
    const settled = operation.then(() => {}, () => {}).finally(() => { this.pending.delete(settled) })
    this.pending.add(settled)
    return operation
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.all(this.pending)
  }

  connect(observe: (event: ToolRunObservation) => void): { errors: unknown[]; disconnect(): void } {
    if (this.current) throw new Error('Tool observations are already connected to a run.')
    const current = { observe, errors: [] as unknown[] }
    this.current = current
    return { errors: current.errors, disconnect: () => {
      if (this.current === current) this.current = undefined
    } }
  }

  publish(event: ToolRunObservation): void {
    const current = this.current
    if (!current) return
    try { current.observe(event) } catch (error) {
      // Keep one diagnostic, but keep observing and never interrupt execution.
      if (!current.errors.length) current.errors.push(error)
    }
  }
}
