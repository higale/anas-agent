import type { AgentRuntimeEvent } from '@shared/agentTypes'
import { roundAvailabilityBatchSize, type RoundChangeAvailability, type RoundChangeAvailabilityInput } from '@shared/fileChanges'

export type RoundChangeView = RoundChangeAvailability['state'] | 'loading' | 'error'
interface Entry {
  runId: string
  state: RoundChangeView
  related: Set<string>
  wanted: number
  attempted: number
  listeners: Set<() => void>
}

/** One cache per conversation. Only mounted message shortcuts request data;
 * multiple messages share their run's result and one bounded batch reader. */
export class RoundChangeAvailabilityStore {
  private entries = new Map<string, Entry>()
  private active = false
  private connected = true
  private timer?: ReturnType<typeof setTimeout>
  private request?: object
  constructor(private readonly threadId: string,
    private readonly read: (input: RoundChangeAvailabilityInput) => Promise<RoundChangeAvailability[]>) {}

  view(runId: string): RoundChangeView { return this.entries.get(runId)?.state ?? 'loading' }
  watch(runId: string, listener: () => void) {
    let entry = this.entries.get(runId)
    if (!entry) {
      entry = { runId, state: 'loading', related: new Set([runId]), wanted: 1, attempted: 0, listeners: new Set() }
      this.entries.set(runId, entry)
    } else {
      this.entries.delete(runId); this.entries.set(runId, entry)
      if (!entry.listeners.size && entry.state === 'error') this.invalidateEntry(entry)
    }
    entry.listeners.add(listener)
    this.schedule()
    return () => { entry.listeners.delete(listener); this.trim() }
  }
  start() { this.active = true; this.connected = true; this.synchronize() }
  dispose() {
    this.active = false; this.request = undefined
    clearTimeout(this.timer); this.timer = undefined
  }
  private trim() {
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= 256) break
      if (!entry.listeners.size) this.entries.delete(id)
    }
  }
  private publish(entry: Entry, state: RoundChangeView) {
    if (entry.state === state) return
    entry.state = state; entry.listeners.forEach(listener => listener())
  }
  private invalidateEntry(entry: Entry) {
    entry.wanted++
    // Keep a known usable shortcut stable during refresh, but never continue
    // hiding one whose previously empty result has been invalidated.
    if (entry.state === 'empty' || entry.state === 'error') this.publish(entry, 'loading')
  }
  synchronize = () => {
    if (!this.active) return
    this.connected = true
    for (const entry of this.entries.values()) this.invalidateEntry(entry)
    this.schedule()
  }
  connectionFailed = () => {
    if (!this.active) return
    this.connected = false; this.request = undefined
    for (const entry of this.entries.values()) this.publish(entry, 'error')
  }
  receive = (event: AgentRuntimeEvent) => {
    if (!this.active || !(event.type === 'file_changes' || event.type === 'subagent_updated' || event.type.startsWith('run_'))) return
    const owner = 'run' in event ? event.run.threadId : event.threadId
    const runId = 'run' in event ? event.run.id : 'runId' in event ? event.runId : undefined
    const related = [...this.entries.values()].filter(entry => runId && entry.related.has(runId))
    if (owner !== this.threadId && !related.length) return
    // A newly created descendant can write before the pending parent's next
    // query has returned its updated scope. Settled unrelated rounds stay cached.
    const affected = related.length ? related : [...this.entries.values()].filter(entry =>
      entry.state !== 'empty' && entry.state !== 'available')
    for (const entry of affected) this.invalidateEntry(entry)
    this.schedule()
  }
  private schedule() {
    if (!this.active || !this.connected || this.timer !== undefined || this.request) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, 100)
  }
  private async flush() {
    if (!this.active || !this.connected || this.request) return
    const selected = [...this.entries.values()].filter(entry => entry.listeners.size && entry.wanted > entry.attempted)
      .slice(0, roundAvailabilityBatchSize).map(entry => ({ entry, revision: entry.wanted }))
    if (!selected.length) return
    const request = {}; this.request = request
    for (const { entry, revision } of selected) entry.attempted = revision
    try {
      const result = await this.read({ threadId: this.threadId, runIds: selected.map(({ entry }) => entry.runId) })
      if (this.request !== request) return
      const byId = new Map(result.map(value => [value.runId, value]))
      if (byId.size !== selected.length || selected.some(({ entry }) => !byId.has(entry.runId))) throw new Error('Round availability scope changed.')
      for (const { entry, revision } of selected) {
        if (this.entries.get(entry.runId) !== entry || entry.wanted !== revision) continue
        const value = byId.get(entry.runId)!
        entry.related = new Set([entry.runId, ...value.relatedRunIds])
        this.publish(entry, value.state)
      }
    } catch {
      if (this.request === request) for (const { entry, revision } of selected) {
        if (this.entries.get(entry.runId) === entry && entry.wanted === revision) this.publish(entry, 'error')
      }
    } finally {
      if (this.request === request) { this.request = undefined; this.trim(); this.schedule() }
    }
  }
}
