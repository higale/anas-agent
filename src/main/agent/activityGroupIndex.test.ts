import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ActivityGroupBuilder, compareActivityPositions, type ActivityAtom, type ActivityViewItem } from '../../shared/activityView'
import { ActivityGroupIndex, activityGroupSchema } from './activityGroupIndex'
import { ActivityDirectoryReader } from './activityDirectoryReader'

const scope = { runId: 'run', agentId: '' }
const tool = (id: number, sequence = id, running = false): ActivityAtom => ({ type: 'entry', position: { key: `tool:${id}`, sequence, part: 1 },
  item: { type: 'tool', key: `tool:${id}`, tool: { call: { id: String(id), name: 'read_file', args: {} }, sequence, status: running ? 'running' : 'completed' } } })
const reply = (id: number, sequence = id): ActivityAtom => ({ type: 'reply', position: { key: `reply:${id}`, sequence, part: 2 },
  model: { id: String(id), messageId: String(id), sequence, text: '', hasText: true, reasoning: '', status: 'completed', toolCallIds: [] } })
function fixture() {
  const database = new Database(':memory:')
  database.exec("CREATE TABLE agent_runs(id TEXT PRIMARY KEY,thread_id TEXT); INSERT INTO agent_runs VALUES('run','thread');" + activityGroupSchema
    + 'CREATE TABLE agent_display_changes(run_id TEXT,source_key TEXT);')
  return { database, index: new ActivityGroupIndex(database) }
}
function outline(database: Database.Database) {
  return (database.prepare(`SELECT item_json,sequence,part,item_key FROM agent_display_groups WHERE run_id='run' AND agent_id=''
    UNION ALL SELECT item_json,sequence,part,item_key FROM agent_display_items WHERE run_id='run' AND agent_id='' AND group_id IS NULL
    ORDER BY sequence,part,item_key`).all() as { item_json: string }[]).map(row => JSON.parse(row.item_json) as ActivityViewItem)
}
function comparable(items: ActivityViewItem[]) {
  return JSON.parse(JSON.stringify(items.map(item => item.type === 'process' ? { ...item, key: undefined } : item)))
}
describe('incremental activity partition', () => {
  it('matches ordered grouping through insertions, status updates, boundary moves and deletions', () => {
    const { database, index } = fixture(), atoms = new Map<string, ActivityAtom>()
    let seed = 71
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
    try {
      for (let step = 0; step < 400; step++) {
        const id = random() % 40, atom = random() % 4 ? tool(id, random() % 55, Boolean(random() % 2)) : reply(id, random() % 55)
        database.transaction(() => {
          if (random() % 5 === 0) { atoms.delete(atom.position.key); index.remove(scope, atom.position.key) }
          else { atoms.set(atom.position.key, atom); index.put(scope, atom.position.key, atom) }
        })()
        const builder = new ActivityGroupBuilder()
        const expected = [...[...atoms.values()].sort((a, b) => compareActivityPositions(a.position, b.position)).flatMap(atom => builder.push(atom)), ...builder.finish()]
        expect(comparable(outline(database)), `step ${step}`).toEqual(comparable(expected))
        const members = database.prepare('SELECT item_key,group_id FROM agent_display_items WHERE process=1').all() as { item_key: string; group_id: string }[]
        for (const group of outline(database)) if (group.type === 'process') {
          const keys = [...atoms.values()].filter(atom => atom.type === 'entry' && compareActivityPositions(atom.position, group.start) >= 0 && compareActivityPositions(atom.position, group.end) <= 0).map(atom => atom.position.key).sort()
          expect(members.filter(row => row.group_id === group.key).map(row => row.item_key).sort()).toEqual(keys)
        }
      }
    } finally { database.close() }
  })
  it('keeps group identities stable, transfers draft ownership and rolls back members and headers together', () => {
    const { database, index } = fixture()
    try {
      index.put(scope, 'model', tool(1)); const key = outline(database)[0].key
      index.put(scope, 'model', tool(2)); index.put(scope, 'call', tool(1))
      index.replaceSource('run', 'model', [{ scope, atom: tool(2) }])
      expect(outline(database)[0].key).toBe(key)
      expect(database.prepare('SELECT item_key FROM agent_display_items ORDER BY sequence').all()).toEqual([{ item_key: 'tool:1' }, { item_key: 'tool:2' }])
      const before = database.serialize()
      expect(() => database.transaction(() => { index.put(scope, 'reply', reply(1)); index.remove(scope, 'tool:2'); throw new Error('failed write') })()).toThrow('failed write')
      expect(database.serialize()).toEqual(before)
      index.remove(scope, 'tool:1')
      expect(outline(database)[0].key).toBe(key)
    } finally { database.close() }
  })
  it('selects the next active or approval member after completion without losing the other parallel tools', () => {
    const { database, index } = fixture()
    try {
      const approval = tool(1, 1, true)
      if (approval.type !== 'entry' || approval.item.type !== 'tool') throw new Error('fixture')
      approval.item.tool.approval = { status: 'pending_approval', interruptId: 'approval', actionIndex: 0 }
      index.put(scope, 'one', approval); index.put(scope, 'two', tool(2, 2, true))
      expect(outline(database)[0]).toMatchObject({ active: { key: 'tool:2' }, attention: { key: 'tool:1' } })
      index.put(scope, 'two', tool(2))
      expect(outline(database)[0]).toMatchObject({ active: { key: 'tool:1' } })
      index.put(scope, 'one', tool(1))
      expect(outline(database)[0]).not.toHaveProperty('active')
      expect(outline(database)[0]).not.toHaveProperty('attention')
    } finally { database.close() }
  })
  it('cold outline reads never parse hidden members and child scopes do not share cache revisions', async () => {
    const { database, index } = fixture()
    try {
      index.put(scope, 'one', tool(1)); index.put(scope, 'two', tool(2)); index.put(scope, 'reply', reply(3))
      const group = outline(database)[0]
      database.pragma('ignore_check_constraints=ON')
      database.prepare("UPDATE agent_display_items SET item_json='unreadable member' WHERE group_id IS NOT NULL").run()
      const reader = new ActivityDirectoryReader(database), input = { threadId: 'thread', runId: 'run', requestId: 'test' }, signal = new AbortController().signal
      expect((await reader.read(input, signal)).items).toHaveLength(2)
      await expect(reader.read({ ...input, parentId: group.key }, signal)).rejects.toThrow()
      expect((await reader.read(input, signal)).items).toHaveLength(2)
    } finally { database.close() }
  })
  it('updates the active title without reading unrelated members', () => {
    const { database, index } = fixture()
    try {
      index.put(scope, 'first', tool(1, 1, true))
      index.put(scope, 'middle', tool(2))
      index.put(scope, 'last', tool(3, 3, true))
      database.pragma('ignore_check_constraints=ON')
      database.prepare("UPDATE agent_display_items SET item_json='unreadable unrelated member' WHERE item_key='tool:2'").run()
      index.put(scope, 'last', tool(3))
      expect(outline(database)[0]).toMatchObject({ active: { key: 'tool:1' }, hasTools: true })
    } finally { database.close() }
  })
})
