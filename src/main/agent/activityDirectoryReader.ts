import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import type { ActivityDirectoryInput, ActivityDirectoryUpdate, ActivityDirectoryItem } from '../../shared/activityDirectory'

interface Directory {
  revision: number
  version: string
  items: Map<string, ActivityDirectoryItem>
  encoded: Map<string, string>
  size: number
}

/** Reads a persisted display scope. Collapsed groups contribute one header;
 * only an explicitly opened group reads its members. No grouping or body reads. */
export class ActivityDirectoryReader {
  private readonly epoch = randomUUID()
  private readonly cache = new Map<string, Directory>()
  constructor(private readonly database: Database.Database) {}

  private revision(input: ActivityDirectoryInput): number {
    return (this.database.prepare('SELECT revision FROM agent_display_versions WHERE run_id=? AND agent_id=? AND parent_id=?')
      .get(input.runId, input.subagentId ?? '', input.parentId ?? '') as { revision: number } | undefined)?.revision ?? 0
  }

  private validate(input: ActivityDirectoryInput) {
    if (!this.database.prepare('SELECT 1 FROM agent_runs WHERE id=? AND thread_id=?').get(input.runId, input.threadId)) {
      throw new Error('Activity run belongs to another conversation.')
    }
    if (input.subagentId && !this.database.prepare("SELECT 1 FROM agent_activities WHERE run_id=? AND activity_key=? AND kind='subagent'")
      .get(input.runId, `subagent:${input.subagentId}`)) throw new Error('Activity child belongs to another run.')
    if (this.database.prepare('SELECT 1 FROM agent_display_changes LIMIT 1').get()) throw new Error('Activity display write is incomplete.')
  }

  private rows({ runId, subagentId, parentId }: ActivityDirectoryInput): { item_json: string }[] {
    return (parentId
      ? this.database.prepare(`SELECT item_json FROM agent_display_items WHERE run_id=? AND agent_id=? AND group_id=?
          ORDER BY sequence,part,item_key`).all(runId, subagentId ?? '', parentId)
      : this.database.prepare(`SELECT item_json,sequence,part,item_key FROM agent_display_groups WHERE run_id=@run AND agent_id=@agent
          UNION ALL SELECT item_json,sequence,part,item_key FROM agent_display_items
          WHERE run_id=@run AND agent_id=@agent AND group_id IS NULL ORDER BY sequence,part,item_key`)
          .all({ run: runId, agent: subagentId ?? '' })) as { item_json: string }[]
  }

  async read(input: ActivityDirectoryInput, signal: AbortSignal): Promise<ActivityDirectoryUpdate> {
    signal.throwIfAborted()
    const key = JSON.stringify([input.threadId, input.runId, input.subagentId, input.parentId])
    const before = this.cache.get(key)
    let current = before
    const captured = this.database.transaction(() => {
      this.validate(input)
      const revision = this.revision(input)
      return current?.revision === revision ? undefined : { revision, rows: this.rows(input) }
    })()
    if (captured) {
      const items = new Map<string, ActivityDirectoryItem>(), encoded = new Map<string, string>()
      let size = 0
      for (let index = 0; index < captured.rows.length; index++) {
        const json = captured.rows[index].item_json, item = JSON.parse(json) as ActivityDirectoryItem
        items.set(item.key, item); encoded.set(item.key, json); size += json.length
        if (index % 128 === 127) { await yieldToLoop(); signal.throwIfAborted() }
      }
      current = { revision: captured.revision, version: `${this.epoch}:${captured.revision}`, items, encoded, size }
      signal.throwIfAborted()
      if (captured.revision === this.revision(input)) { this.cache.delete(key); this.cache.set(key, current) }
      while (this.cache.size > 64 || [...this.cache.values()].reduce((total, item) => total + item.size, 0) > 32_000_000) this.cache.delete(this.cache.keys().next().value!)
    }
    const next = current!
    if (input.version === next.version) return { version: next.version, baseVersion: next.version, items: [], removed: [] }
    if (before && input.version === before.version) return {
      version: next.version, baseVersion: before.version,
      items: [...next.items.values()].filter(item => before.encoded.get(item.key) !== next.encoded.get(item.key)),
      removed: [...before.items.keys()].filter(key => !next.items.has(key))
    }
    return { version: next.version, items: [...next.items.values()], removed: [] }
  }
}
