import { describe, expect, it } from 'vitest'
import { ActivityGroupBuilder, type ActivityAtom } from './activityView'

const tool = (sequence: number): ActivityAtom => ({ type: 'entry', position: { sequence, part: 1, key: `tool:${sequence}` },
  item: { type: 'tool', key: `tool:${sequence}`, tool: { sequence, call: { id: String(sequence), name: 'read_file', args: {} }, status: 'completed' } } })
const reply = (sequence: number): ActivityAtom => ({ type: 'reply', position: { sequence, part: 2, key: `reply:${sequence}` },
  model: { id: String(sequence), sequence, status: 'completed', text: '', hasText: true, reasoning: '', toolCallIds: [] } })
const group = (atoms: ActivityAtom[]) => {
  const builder = new ActivityGroupBuilder()
  return [...atoms.flatMap(atom => builder.push(atom)), ...builder.finish()]
}

describe('activity grouping', () => {
  it('keeps a long process whole and its following reply reachable', () => {
    const items = group([reply(0), ...Array.from({ length: 10000 }, (_, index) => tool(index + 1)), reply(10001)])
    expect(items.map(item => item.type)).toEqual(['reply', 'process', 'reply'])
    expect(items[1]).toMatchObject({ hasTools: true, start: tool(1).position, end: tool(10000).position })
    expect(JSON.stringify(items[1]).length).toBeLessThan(1000)
  })
  it('retains stable identities while groups grow and replies close them', () => {
    const before = group([tool(0)]), after = group([tool(0), tool(1), reply(1), tool(2)])
    expect(after[0].key).toBe(before[0].key)
    expect(after.map(item => item.type)).toEqual(['process', 'reply', 'process'])
    expect(after[0].end.sequence).toBe(after[1].start.sequence)
    expect(after[0].end.part).toBeLessThan(after[1].start.part)
  })
  it('preserves an approval even when later parallel tools are running', () => {
    const waiting = tool(0), running = tool(1)
    if (waiting.type !== 'entry' || waiting.item.type !== 'tool' || running.type !== 'entry' || running.item.type !== 'tool') throw new Error('fixture')
    waiting.item.tool.status = running.item.tool.status = 'running'
    waiting.item.tool.approval = { status: 'pending_approval', interruptId: 'approval', actionIndex: 0 }
    expect(group([waiting, running])[0]).toMatchObject({ attention: waiting.item, active: running.item })
  })
})
