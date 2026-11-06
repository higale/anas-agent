import { applyActivityDirectory, type ActivityDirectoryInput, type ActivityDirectoryResult, type ActivityDirectoryItem } from '@shared/activityDirectory'
import { compareActivityPositions, type ActivityViewItem } from '@shared/activityView'

export type DirectoryScope = Pick<ActivityDirectoryInput, 'runId' | 'subagentId' | 'parentId'>
export const directoryScopeKey = (scope: DirectoryScope) => JSON.stringify([scope.runId, scope.subagentId, scope.parentId])
export interface DirectoryView { items: ActivityViewItem[]; initialized: boolean; loading: boolean; error?: unknown }
interface Entry {
  scope: DirectoryScope
  items: ReadonlyMap<string, ActivityDirectoryItem>
  version?: string
  view: DirectoryView
  wanted: number
  applied: number
  request?: string
  error?: unknown
}
interface DirectoryService {
  directory(input: ActivityDirectoryInput): Promise<ActivityDirectoryResult>
  cancel(request: string): Promise<unknown>
}

/** Data ownership only. Scroll intent, navigation and layout never enter this
 * store; every success applies one revision, every invalidation advances demand. */
export class ActivityDirectoryStore {
  private entries = new Map<string, Entry>()
  private listeners = new Set<() => void>()
  private timer?: ReturnType<typeof setTimeout>
  private revision = 0
  private active = true
  private connectionError?: unknown
  constructor(private readonly threadId: string, private readonly service: DirectoryService) {}
  snapshot = () => this.revision
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private changed() { this.revision++; this.listeners.forEach(listener => listener()) }
  private publish(entry: Entry, view: DirectoryView) {
    const previous = entry.view
    if (previous.items === view.items && previous.initialized === view.initialized
      && previous.loading === view.loading && previous.error === view.error) return
    entry.view = view; this.changed()
  }
  private cancel(entry: Entry) {
    const request = entry.request
    entry.request = undefined
    if (request) void this.service.cancel(request).catch(() => {})
  }
  start() { this.active = true }
  dispose() {
    this.active = false
    clearTimeout(this.timer); this.timer = undefined
    for (const entry of this.entries.values()) this.cancel(entry)
    this.entries.clear()
  }
  view(scope: DirectoryScope): DirectoryView {
    const entry = this.entries.get(directoryScopeKey(scope))
    const view = entry?.view ?? { items: [], initialized: false, loading: true }
    return this.connectionError ? { ...view, error: this.connectionError, loading: false } : view
  }
  sync(scopes: DirectoryScope[]) {
    if (!this.active) return
    const selected = new Map(scopes.map(scope => [directoryScopeKey(scope), scope]))
    for (const [key, entry] of this.entries) if (!selected.has(key)) {
      this.cancel(entry)
      this.entries.delete(key)
    }
    for (const [key, scope] of selected) if (!this.entries.has(key)) {
      const entry: Entry = { scope, items: new Map(), view: { items: [], initialized: false, loading: true }, wanted: 1, applied: 0 }
      this.entries.set(key, entry)
      void this.read(key, entry)
    }
  }
  invalidate(runId?: string) {
    if (!this.active) return
    for (const entry of this.entries.values()) if (!runId || entry.scope.runId === runId) entry.wanted++
    this.timer ??= setTimeout(() => { this.timer = undefined; this.flush() }, 100)
  }
  synchronize = async () => {
    if (!this.active) return
    const failed = this.connectionError !== undefined
    this.connectionError = undefined
    for (const entry of this.entries.values()) { this.cancel(entry); entry.error = undefined }
    this.invalidate(); this.flush(); if (failed) this.changed()
  }
  connectionFailed = (error: unknown) => { if (this.active) { this.connectionError = error; this.changed() } }
  retry(scope: DirectoryScope) {
    const failed = this.connectionError !== undefined
    this.connectionError = undefined
    if (failed) this.changed()
    const key = directoryScopeKey(scope), entry = this.entries.get(key)
    if (!entry) return
    this.cancel(entry)
    entry.error = undefined; entry.wanted++
    void this.read(key, entry)
  }
  private flush() {
    if (!this.active || this.connectionError) return
    for (const [key, entry] of this.entries) if (entry.applied < entry.wanted && !entry.error) void this.read(key, entry)
  }
  private async read(key: string, entry: Entry) {
    if (entry.request || !this.active) return
    const requestId = crypto.randomUUID(), target = entry.wanted
    entry.request = requestId
    // Refresh demand is internal state. A readable tree remains ready while
    // the server checks its version; only visible changes notify the panel.
    this.publish(entry, { ...entry.view, loading: !entry.view.initialized, error: undefined })
    try {
      const update = await this.service.directory({ threadId: this.threadId, ...entry.scope, requestId, version: entry.version })
      if (!this.active || this.entries.get(key) !== entry || entry.request !== requestId) return
      // Locally cancelled requests have already lost ownership above. An
      // unexpected remote cancellation remains retryable without erasing data.
      if ('cancelled' in update) throw new Error('Activity directory read was cancelled.')
      const items = applyActivityDirectory(entry.items, entry.version, update)
      entry.version = update.version; entry.applied = target
      if (items !== entry.items) {
        entry.items = items
        const ordered = [...items.values()].sort((a, b) => compareActivityPositions(a.start, b.start))
        this.publish(entry, { items: ordered, initialized: true, loading: false })
      }
      entry.error = undefined
    } catch (error) {
      if (!this.active || this.entries.get(key) !== entry || entry.request !== requestId) return
      entry.error = error; this.publish(entry, { ...entry.view, loading: false, error })
    } finally {
      if (this.active && this.entries.get(key) === entry && entry.request === requestId) {
        entry.request = undefined
        if (!entry.error && !this.connectionError && entry.applied < entry.wanted) void this.read(key, entry)
      }
    }
  }
}
