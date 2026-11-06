import type { AgentRunReferenceInput } from './agentTypes'
import type { ActivityViewItem } from './activityView'

export interface ActivityDirectoryInput extends AgentRunReferenceInput {
  requestId: string
  subagentId?: string
  parentId?: string
  version?: string
}
export type ActivityDirectoryItem = ActivityViewItem

/** One complete scope revision, or an atomic difference from baseVersion.
 * Loading chunks and viewport size never define membership. */
export interface ActivityDirectoryUpdate {
  version: string
  baseVersion?: string
  items: ActivityDirectoryItem[]
  removed: string[]
}

/** An intentional IPC cancellation carries no directory revision or data. */
export type ActivityDirectoryResult = ActivityDirectoryUpdate | { cancelled: true }

export function applyActivityDirectory(previous: ReadonlyMap<string, ActivityDirectoryItem>, version: string | undefined,
  update: ActivityDirectoryUpdate): ReadonlyMap<string, ActivityDirectoryItem> {
  if (update.baseVersion !== undefined && update.baseVersion !== version) throw new Error('Activity directory revision does not match.')
  if (update.baseVersion !== undefined && !update.items.length && !update.removed.length) return previous
  const next = update.baseVersion === undefined ? new Map<string, ActivityDirectoryItem>() : new Map(previous)
  for (const key of update.removed) next.delete(key)
  for (const item of update.items) next.set(item.key, item)
  return next
}
