import type { AgentModelActivity } from './agentTypes'
import type { TurnTimelineActivityItem, TurnTimelineModelItem, TurnTimelineToolItem } from './agentTimeline'

/** A model may own both a process entry and a reply. A sequence alone cannot
 * address a display boundary. Keys disambiguate summaries at the same anchor. */
export interface ActivityPosition { sequence: number; part: number; key: string }
export const compareActivityPositions = (a: ActivityPosition, b: ActivityPosition) =>
  a.sequence - b.sequence || a.part - b.part || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)

export type ActivityProcessItem = TurnTimelineModelItem | TurnTimelineToolItem
export type ActivityAtom = {
  position: ActivityPosition
} & ({ type: 'entry'; item: TurnTimelineActivityItem } | { type: 'reply'; model: AgentModelActivity })

export interface ActivityGroup {
  type: 'process'
  key: string
  start: ActivityPosition
  end: ActivityPosition
  hasThought: boolean
  hasTools: boolean
  first: ActivityProcessItem
  active?: ActivityProcessItem
  attention?: ActivityProcessItem
}
export type ActivityViewItem = ActivityGroup | (ActivityAtom & { key: string; start: ActivityPosition; end: ActivityPosition })
export function isProcessAtom(atom: ActivityAtom): atom is ActivityAtom & { type: 'entry'; item: ActivityProcessItem } {
  return atom.type === 'entry' && (atom.item.type === 'model' || atom.item.type === 'tool')
}

/** The small optimistic/in-memory timeline uses the same grouping contract. */
export function activityAtomsFromItems(items: TurnTimelineActivityItem[]): ActivityAtom[] {
  let previousSequence = -1
  return items.flatMap((item): ActivityAtom[] => {
    const sequence = item.type === 'model' ? item.model.sequence : item.type === 'tool' ? item.tool.sequence
      : item.type === 'subagent' ? item.subagent.sequence : item.type === 'summary' ? item.summary.firstPreservedActivitySequence ?? item.summary.sequence
        : item.type === 'skill' ? -1 : previousSequence
    previousSequence = sequence
    const atom: ActivityAtom = { type: 'entry', item: item.type === 'model' ? { ...item, showText: false } : item,
      position: { sequence, part: item.type === 'summary' || item.type === 'skill' ? 0 : item.type === 'direction' ? Number.MAX_SAFE_INTEGER
        : item.type === 'tool' && item.progress ? 3 + item.progress.index : 1, key: item.key } }
    return item.type === 'model' && item.showText && (item.model.hasText || /\S/.test(item.model.text))
      ? [atom, { type: 'reply', model: item.model, position: { sequence, part: 2, key: `text:${item.key}` } }] : [atom]
  })
}

function isActive(item: ActivityProcessItem) {
  return item.type === 'tool' ? item.tool.status === 'running' : item.model.status === 'running' && !item.model.hasText && !/\S/.test(item.model.text)
}

/** Grouping depends only on the ordered activity stream, never on page size,
 * rendering, or the reader's disclosure choices. Holds one summary per group. */
export class ActivityGroupBuilder {
  private group?: ActivityGroup
  push(atom: ActivityAtom): ActivityViewItem[] {
    if (!isProcessAtom(atom)) {
      const result = this.finish()
      return [...result, { ...atom, key: atom.position.key, start: atom.position, end: atom.position }]
    }
    const item = atom.item
    if (!this.group) this.group = { type: 'process', key: `process:${atom.position.key}`, start: atom.position, end: atom.position, first: item, hasThought: false, hasTools: false }
    const group = this.group
    if (item.type === 'model' && (item.model.hasReasoning || item.model.reasoning)) group.hasThought = true
    if (item.type === 'tool') group.hasTools = true
    group.end = atom.position
    if (isActive(item)) group.active = item
    if (item.type === 'tool' && (item.tool.approval || item.tool.status === 'running' && item.tool.call.name === 'request_user_input')) group.attention = item
    return []
  }
  finish(): ActivityGroup[] {
    const group = this.group; this.group = undefined
    return group ? [group] : []
  }
}
