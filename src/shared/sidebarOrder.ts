import type { AgentThread } from './agentTypes'

export interface SidebarReorderRequest {
  kind: 'project' | 'thread'
  groupId: string
  pinned: boolean
  id: string
  beforeId: string | null
}

export function orderProjectThreads(threads: AgentThread[], order?: string[]): AgentThread[] {
  const positions = new Map(order?.map((id, index) => [id, index]))
  return [...threads].sort((left, right) => Number(right.pinned) - Number(left.pinned)
    || (positions.get(left.id) ?? -1) - (positions.get(right.id) ?? -1)
    || Date.parse(order ? right.createdAt : right.updatedAt) - Date.parse(order ? left.createdAt : left.updatedAt)
    || left.id.localeCompare(right.id))
}

/** Validate the current group again at commit time; never change group or pin state. */
export function reorderSidebarItems<T extends { id: string }>(items: T[], request: SidebarReorderRequest): T[] {
  const source = items.find((item) => item.id === request.id)
  if (!source || (request.beforeId !== null && !items.some((item) => item.id === request.beforeId))) {
    throw new Error('Sidebar order target changed. Refresh the list and try again.')
  }
  if (request.id === request.beforeId) return items
  const remaining = items.filter((item) => item.id !== request.id)
  const index = request.beforeId === null ? remaining.length : remaining.findIndex((item) => item.id === request.beforeId)
  remaining.splice(index, 0, source)
  return remaining
}
