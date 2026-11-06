import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { ActivityAtom, ActivityGroup, ActivityPosition, ActivityProcessItem, ActivityViewItem } from '../../shared/activityView'
import { ActivityGroupBuilder, isProcessAtom } from '../../shared/activityView'

export interface DisplayScope { runId: string; agentId: string }
interface ItemRow {
  item_key: string; source_key: string; sequence: number; part: number; group_id: string | null; process: number
  item_json: string
}

/** Offline integrity validation, never part of a timeline read. */
export function validateActivityGroupIndex(database: Database.Database): void {
  const fail = (): never => { throw new Error('Invalid activity display group directory.') }
  const groups = new Map((database.prepare('SELECT run_id,agent_id,group_id,item_json FROM agent_display_groups').all() as {
    run_id: string; agent_id: string; group_id: string; item_json: string
  }[]).map(row => [JSON.stringify([row.run_id, row.agent_id, row.group_id]), row.item_json]))
  let scope = '', groupId: string | null = null, builder = new ActivityGroupBuilder()
  const finish = () => {
    const expected = builder.finish()[0]
    if (!expected) return
    const id = JSON.stringify([...JSON.parse(scope) as string[], groupId]), json = groups.get(id)
    if (!json || !isDeepStrictEqual(JSON.parse(json), JSON.parse(JSON.stringify({ ...expected, key: groupId })))) fail()
    groups.delete(id)
  }
  for (const row of database.prepare('SELECT * FROM agent_display_items ORDER BY run_id,agent_id,sequence,part,item_key').iterate() as Iterable<ItemRow & { run_id: string; agent_id: string }>) {
    const nextScope = JSON.stringify([row.run_id, row.agent_id]), item = member(row)
    if (!item || item.type !== 'entry' && item.type !== 'reply' || !isDeepStrictEqual(item.start, position(row))
      || !isDeepStrictEqual(item.end, position(row)) || item.key !== row.item_key) fail()
    if (nextScope !== scope) { finish(); scope = nextScope; groupId = null; builder = new ActivityGroupBuilder() }
    const process = isProcessAtom(item as ActivityAtom)
    if (Boolean(row.process) !== process || process !== Boolean(row.group_id)) fail()
    if (process) {
      if (groupId && row.group_id !== groupId) fail()
      groupId = row.group_id
      builder.push(item as ActivityAtom)
    } else { finish(); groupId = null }
  }
  finish()
  if (groups.size) fail()
}
export const activityGroupSchema = `
  CREATE TABLE agent_display_items (
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, agent_id TEXT NOT NULL,
    item_key TEXT NOT NULL, source_key TEXT NOT NULL, sequence INTEGER NOT NULL, part INTEGER NOT NULL,
    group_id TEXT, process INTEGER NOT NULL CHECK(process IN (0,1)),
    active INTEGER NOT NULL CHECK(active IN (0,1)), attention INTEGER NOT NULL CHECK(attention IN (0,1)),
    thought INTEGER NOT NULL CHECK(thought IN (0,1)), tool INTEGER NOT NULL CHECK(tool IN (0,1)),
    transient INTEGER NOT NULL CHECK(transient IN (0,1)), item_json TEXT NOT NULL CHECK(json_valid(item_json)),
    PRIMARY KEY(run_id,agent_id,item_key)
  );
  CREATE INDEX display_item_order ON agent_display_items(run_id,agent_id,sequence,part,item_key);
  CREATE INDEX display_item_source ON agent_display_items(run_id,source_key,agent_id);
  CREATE INDEX display_item_members ON agent_display_items(run_id,agent_id,group_id,sequence,part,item_key);
  CREATE INDEX display_item_outer ON agent_display_items(run_id,agent_id,sequence,part,item_key) WHERE group_id IS NULL;
  CREATE INDEX display_item_active ON agent_display_items(run_id,agent_id,group_id,sequence DESC,part DESC,item_key DESC) WHERE active=1;
  CREATE INDEX display_item_attention ON agent_display_items(run_id,agent_id,group_id,sequence DESC,part DESC,item_key DESC) WHERE attention=1;
  CREATE INDEX display_item_thought ON agent_display_items(run_id,agent_id,group_id) WHERE thought=1;
  CREATE INDEX display_item_tool ON agent_display_items(run_id,agent_id,group_id) WHERE tool=1;
  CREATE INDEX display_item_transient ON agent_display_items(run_id,source_key) WHERE transient=1;
  CREATE TABLE agent_display_groups (
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, agent_id TEXT NOT NULL,
    group_id TEXT NOT NULL, sequence INTEGER NOT NULL, part INTEGER NOT NULL, item_key TEXT NOT NULL,
    item_json TEXT NOT NULL CHECK(json_valid(item_json)), PRIMARY KEY(run_id,agent_id,group_id)
  );
  CREATE INDEX display_group_order ON agent_display_groups(run_id,agent_id,sequence,part,item_key);
  CREATE TABLE agent_display_versions (
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, agent_id TEXT NOT NULL,
    parent_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(run_id,agent_id,parent_id)
  );
  CREATE TABLE agent_display_delegations (
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    activity_key TEXT NOT NULL, child_id TEXT NOT NULL, PRIMARY KEY(run_id,activity_key)
  );
  CREATE INDEX display_delegation_child ON agent_display_delegations(run_id,child_id);
`

const position = (row: ItemRow): ActivityPosition => ({ sequence: row.sequence, part: row.part, key: row.item_key })
const member = (row: ItemRow): ActivityViewItem => JSON.parse(row.item_json) as ActivityViewItem
const processItem = (row: ItemRow | undefined): ActivityProcessItem | undefined => {
  if (!row) return undefined
  const item = member(row)
  if (item.type !== 'entry' || item.item.type !== 'model' && item.item.type !== 'tool') throw new Error('Invalid display group member.')
  return item.item
}

/** Maintains the ordered display partition at the write boundary. Ordinary
 * appends and status changes visit only adjacent/index-selected records.
 * Inserting/removing a boundary changes only that boundary's member range. */
export class ActivityGroupIndex {
  constructor(private readonly database: Database.Database) {}

  private bump(scope: DisplayScope, parentId = '') {
    this.database.prepare(`INSERT INTO agent_display_versions(run_id,agent_id,parent_id,revision) VALUES(?,?,?,1)
      ON CONFLICT(run_id,agent_id,parent_id) DO UPDATE SET revision=revision+1`).run(scope.runId, scope.agentId, parentId)
  }
  private neighbor(scope: DisplayScope, at: ActivityPosition, before: boolean): ItemRow | undefined {
    return this.database.prepare(`SELECT * FROM agent_display_items WHERE run_id=? AND agent_id=?
      AND (sequence,part,item_key) ${before ? '<' : '>'} (?,?,?)
      ORDER BY sequence ${before ? 'DESC' : 'ASC'},part ${before ? 'DESC' : 'ASC'},item_key ${before ? 'DESC' : 'ASC'} LIMIT 1`)
      .get(scope.runId, scope.agentId, at.sequence, at.part, at.key) as ItemRow | undefined
  }
  private refresh(scope: DisplayScope, groupId: string) {
    const arguments_ = [scope.runId, scope.agentId, groupId]
    const select = (condition: string, order: string) => this.database.prepare(`SELECT * FROM agent_display_items
      WHERE run_id=? AND agent_id=? AND group_id=? ${condition} ORDER BY ${order} LIMIT 1`).get(...arguments_) as ItemRow | undefined
    const first = select('', 'sequence,part,item_key')
    if (!first) {
      if (this.database.prepare('DELETE FROM agent_display_groups WHERE run_id=? AND agent_id=? AND group_id=?').run(...arguments_).changes) this.bump(scope)
      this.bump(scope, groupId)
      return
    }
    const last = select('', 'sequence DESC,part DESC,item_key DESC')!
    const group: ActivityGroup = {
      type: 'process', key: groupId, start: position(first), end: position(last), first: processItem(first)!,
      active: processItem(select('AND active=1', 'sequence DESC,part DESC,item_key DESC')),
      attention: processItem(select('AND attention=1', 'sequence DESC,part DESC,item_key DESC')),
      hasThought: Boolean(this.database.prepare('SELECT 1 FROM agent_display_items WHERE run_id=? AND agent_id=? AND group_id=? AND thought=1 LIMIT 1').get(...arguments_)),
      hasTools: Boolean(this.database.prepare('SELECT 1 FROM agent_display_items WHERE run_id=? AND agent_id=? AND group_id=? AND tool=1 LIMIT 1').get(...arguments_))
    }
    const json = JSON.stringify(group)
    const changed = this.database.prepare(`INSERT INTO agent_display_groups(run_id,agent_id,group_id,sequence,part,item_key,item_json)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(run_id,agent_id,group_id) DO UPDATE SET
      sequence=excluded.sequence,part=excluded.part,item_key=excluded.item_key,item_json=excluded.item_json
      WHERE item_json<>excluded.item_json`).run(...arguments_, first.sequence, first.part, first.item_key, json).changes
    if (changed) this.bump(scope)
  }
  private join(scope: DisplayScope, keep: string, remove: string) {
    if (keep === remove) return
    this.database.prepare('UPDATE agent_display_items SET group_id=? WHERE run_id=? AND agent_id=? AND group_id=?')
      .run(keep, scope.runId, scope.agentId, remove)
    this.refresh(scope, remove); this.bump(scope, keep)
  }
  private newGroupId(scope: DisplayScope, key: string) {
    const base = `process:${key}`
    return this.database.prepare('SELECT 1 FROM agent_display_groups WHERE run_id=? AND agent_id=? AND group_id=?').get(scope.runId, scope.agentId, base)
      ? `${base}:${randomUUID()}` : base
  }
  remove(scope: DisplayScope, key: string): void {
    const row = this.database.prepare('SELECT * FROM agent_display_items WHERE run_id=? AND agent_id=? AND item_key=?')
      .get(scope.runId, scope.agentId, key) as ItemRow | undefined
    if (!row) return
    const before = this.neighbor(scope, position(row), true), after = this.neighbor(scope, position(row), false)
    this.database.prepare('DELETE FROM agent_display_items WHERE run_id=? AND agent_id=? AND item_key=?').run(scope.runId, scope.agentId, key)
    if (row.group_id) { this.bump(scope, row.group_id); this.refresh(scope, row.group_id) }
    else {
      this.bump(scope)
      if (before?.group_id && after?.group_id) {
        this.join(scope, before.group_id, after.group_id); this.refresh(scope, before.group_id)
      }
    }
  }
  put(scope: DisplayScope, sourceKey: string, atom: ActivityAtom): void {
    const at = atom.position, process = isProcessAtom(atom)
    const item: ActivityViewItem = { ...atom, key: at.key, start: at, end: at }
    const json = JSON.stringify(item)
    let previous = this.database.prepare('SELECT * FROM agent_display_items WHERE run_id=? AND agent_id=? AND item_key=?')
      .get(scope.runId, scope.agentId, at.key) as ItemRow | undefined
    if (previous?.item_json === json) {
      if (previous.source_key !== sourceKey) this.database.prepare('UPDATE agent_display_items SET source_key=? WHERE run_id=? AND agent_id=? AND item_key=?')
        .run(sourceKey, scope.runId, scope.agentId, at.key)
      return
    }
    if (previous && (previous.sequence !== at.sequence || previous.part !== at.part || previous.process !== Number(process))) {
      this.remove(scope, at.key); previous = undefined
    }
    let groupId = previous?.group_id ?? null
    const before = previous ? undefined : this.neighbor(scope, at, true)
    const after = previous ? undefined : this.neighbor(scope, at, false)
    if (!previous && process) {
      groupId = before?.group_id ?? after?.group_id ?? this.newGroupId(scope, at.key)
      if (before?.group_id && after?.group_id) this.join(scope, before.group_id, after.group_id)
    }
    const thought = process && atom.item.type === 'model' && Boolean(atom.item.model.hasReasoning || atom.item.model.reasoning)
    const tool = process && atom.item.type === 'tool'
    const transient = atom.type === 'reply' ? !atom.model.messageId
      : process && (atom.item.type === 'model' ? !atom.item.model.messageId : atom.item.tool.status === 'running')
    const active = process && (atom.item.type === 'tool' ? atom.item.tool.status === 'running'
      : atom.item.model.status === 'running' && !atom.item.model.hasText)
    const attention = process && atom.item.type === 'tool' && Boolean(atom.item.tool.approval
      || atom.item.tool.status === 'running' && atom.item.tool.call.name === 'request_user_input')
    this.database.prepare(`INSERT INTO agent_display_items
      (run_id,agent_id,item_key,source_key,sequence,part,group_id,process,active,attention,thought,tool,transient,item_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,agent_id,item_key) DO UPDATE SET
      source_key=excluded.source_key,sequence=excluded.sequence,part=excluded.part,group_id=excluded.group_id,
      process=excluded.process,active=excluded.active,attention=excluded.attention,
      thought=excluded.thought,tool=excluded.tool,transient=excluded.transient,item_json=excluded.item_json`)
      .run(scope.runId, scope.agentId, at.key, sourceKey, at.sequence, at.part, groupId, Number(process), Number(active), Number(attention),
        Number(thought), Number(tool), Number(transient), json)
    if (groupId) { this.bump(scope, groupId); this.refresh(scope, groupId) }
    else {
      this.bump(scope)
      if (!previous && before?.group_id && before.group_id === after?.group_id) {
        const splitId = this.newGroupId(scope, after.item_key)
        this.database.prepare(`UPDATE agent_display_items SET group_id=? WHERE run_id=? AND agent_id=? AND group_id=?
          AND (sequence,part,item_key)>(?,?,?)`).run(splitId, scope.runId, scope.agentId, before.group_id, at.sequence, at.part, at.key)
        this.bump(scope, before.group_id); this.bump(scope, splitId)
        this.refresh(scope, before.group_id); this.refresh(scope, splitId)
      }
    }
  }
  /** A source owns its model/reply/draft rows together. Removed drafts and
   * discarded models cannot leave stale members in a persisted group. */
  replaceSource(runId: string, sourceKey: string, atoms: { scope: DisplayScope; atom: ActivityAtom }[]): void {
    const next = new Set(atoms.map(({ scope, atom }) => JSON.stringify([scope.agentId, atom.position.key])))
    const previous = this.database.prepare('SELECT agent_id,item_key FROM agent_display_items WHERE run_id=? AND source_key=?')
      .all(runId, sourceKey) as { agent_id: string; item_key: string }[]
    for (const row of previous) if (!next.has(JSON.stringify([row.agent_id, row.item_key]))) this.remove({ runId, agentId: row.agent_id }, row.item_key)
    for (const { scope, atom } of atoms) this.put(scope, sourceKey, atom)
  }
}
