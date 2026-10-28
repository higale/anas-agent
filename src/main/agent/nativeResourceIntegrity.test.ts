import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { SqliteMemoryStore } from './memoryStore'
import { FileEditStore } from '../fileEditStore'
import { defaultCapabilities } from '../../shared/agentCapabilities'
import { DEFAULT_WORKSPACE_PROJECT_ID } from '../../shared/types'
import { archiveAgentAttachments } from './agentAttachmentStore'

async function fixture() {
  const parent = join(process.cwd(), 'tmp'); mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, 'native-resource-integrity-')), file = join(root, 'conversation.sqlite')
  const global = new Database(':memory:'), attachmentRoot = join(root, 'attachments')
  const options = { attachmentRoot, memoryStore: new SqliteMemoryStore(global), fileEditStore: new FileEditStore(join(root, 'file-edits')) }
  let current: NativeConversationDatabase | undefined = NativeConversationDatabase.open(file, options)
  const owner = { threadId: randomUUID(), runId: randomUUID() }, child = { id: randomUUID(), threadId: randomUUID(), runId: randomUUID() }
  const source = join(root, 'source.txt'); writeFileSync(source, 'Preserve this attachment')
  const attachments = await archiveAgentAttachments([{ path: source, name: 'source.txt', mimeType: 'text/plain', kind: 'text', size: 24, contextPolicy: 'conversation' }],
    { ...owner, messageId: `${owner.runId}:input` }, attachmentRoot)
  current.runs.createThreadAndRun({ ...owner, thread: {}, submissionId: randomUUID(), attachments,
    message: { id: `${owner.runId}:input`, value: { id: `${owner.runId}:input`, kind: 'user', content: 'Isolated resource integrity', context: { runId: owner.runId } } } })
  current.runs.createSubagentCall({ id: child.id, ownerThreadId: owner.threadId, parentThreadId: owner.threadId, parentRunId: owner.runId,
    childThreadId: child.threadId, childRunId: child.runId, childThread: {}, description: 'Isolated child',
    config: { capabilities: structuredClone(defaultCapabilities), index: 0, name: 'helper', enabled: true, builtIn: false, description: 'Help', systemPrompt: 'Help' } })
  const managedId = randomUUID()
  current.managed.createManagedCall({ id: managedId, ...owner, kind: 'http', summary: 'Saved pending call' })
  const close = () => { current?.close(); current = undefined }
  return { root, file, owner, child, managedId, attachment: attachments[0].artifact, attachmentRoot,
    close, open() { current = NativeConversationDatabase.open(file, options); return current },
    edit(action: (sql: Database.Database) => void, foreignKeys = false) {
      close(); const sql = new Database(file)
      try { sql.pragma(`foreign_keys=${foreignKeys ? 'ON' : 'OFF'}`); action(sql) } finally { sql.close() }
    },
    backup() { NativeConversationDatabase.validateBackup(file, attachmentRoot, new Set([DEFAULT_WORKSPACE_PROJECT_ID]), owner.threadId) },
    dispose() { close(); global.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
  }
}

function rejectWithoutChanging(h: Awaited<ReturnType<typeof fixture>>, message: string | RegExp) {
  const before = readFileSync(h.file), attachment = readFileSync(h.attachment.path)
  expect(() => h.backup()).toThrow(message)
  expect(readFileSync(h.file).equals(before)).toBe(true)
  expect(() => h.open()).toThrow(message)
  expect(readFileSync(h.file).equals(before)).toBe(true)
  expect(readFileSync(h.attachment.path).equals(attachment)).toBe(true)
}

describe('native resource ownership and startup integrity', () => {
  it('rejects an incomplete managed-call table while preserving its running call and attachment', async () => {
    const h = await fixture()
    try {
      h.edit(sql => {
        sql.prepare("UPDATE agent_managed_calls SET status='running' WHERE id=?").run(h.managedId)
        sql.exec('ALTER TABLE agent_managed_calls DROP COLUMN outcome_json')
      })
      rejectWithoutChanging(h, 'Invalid native conversation schema: agent_managed_calls')
      h.edit(sql => expect(sql.prepare('SELECT status FROM agent_managed_calls WHERE id=?').get(h.managedId)).toEqual({ status: 'running' }))
    } finally { h.dispose() }
  })

  it('enforces managed call and observation ownership in SQLite without affecting the valid pending call', async () => {
    const h = await fixture()
    try {
      h.edit(sql => {
        expect(() => sql.prepare('UPDATE agent_managed_calls SET run_id=? WHERE id=?').run(h.child.runId, h.managedId)).toThrow('FOREIGN KEY constraint failed')
        const insert = sql.prepare('INSERT INTO agent_managed_call_observations(call_id,thread_id,run_id,observed_at) VALUES (?,?,?,?)')
        const now = new Date().toISOString()
        expect(() => insert.run(h.managedId, h.owner.threadId, h.child.runId, now)).toThrow('FOREIGN KEY constraint failed')
        expect(() => insert.run(h.managedId, h.child.threadId, h.child.runId, now)).toThrow('FOREIGN KEY constraint failed')
      }, true)
      h.backup()
      expect(h.open().managed.getManagedCall(h.managedId, h.owner.threadId)).toMatchObject({ status: 'preparing', runId: h.owner.runId })
    } finally { h.dispose() }
  })

  it.each(['agent_managed_calls', 'agent_managed_call_observations', 'agent_hidden_threads', 'agent_subagent_calls', 'agent_subagent_observations'])(
    'rejects missing cascade semantics in %s on open and backup without repairing the source', async table => {
      const h = await fixture()
      try {
        h.edit(sql => {
          const schema = sql.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(table) as { sql: string }
          const indexes = sql.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(table) as Array<{ sql: string }>
          sql.exec(`CREATE TEMP TABLE fixture_rows AS SELECT * FROM ${table}; DROP TABLE ${table}`)
          sql.exec(schema.sql.replaceAll('ON DELETE CASCADE', 'ON DELETE RESTRICT'))
          sql.exec(`INSERT INTO ${table} SELECT * FROM fixture_rows; DROP TABLE fixture_rows`)
          for (const index of indexes) sql.exec(index.sql)
        })
        rejectWithoutChanging(h, `Invalid native conversation schema: ${table}`)
      } finally { h.dispose() }
    })

  it.each(['managed-orphan', 'managed-wrong-run', 'managed-observation-run', 'managed-observation-owner', 'child-observation', 'visible-child', 'live-thread-cleanup', 'live-file-cleanup'] as const)(
    'rejects %s evidence before opening or restoring the conversation', async kind => {
      const h = await fixture()
      try {
        h.edit(sql => {
          const now = new Date().toISOString()
          if (kind === 'managed-orphan' || kind === 'managed-wrong-run') {
            sql.prepare('UPDATE agent_managed_calls SET run_id=? WHERE id=?').run(kind === 'managed-orphan' ? 'missing-run' : h.child.runId, h.managedId)
          } else if (kind === 'managed-observation-run' || kind === 'managed-observation-owner') {
            sql.prepare('INSERT INTO agent_managed_call_observations(call_id,thread_id,run_id,observed_at) VALUES (?,?,?,?)')
              .run(h.managedId, kind === 'managed-observation-run' ? h.owner.threadId : h.child.threadId, h.child.runId, now)
          } else if (kind === 'child-observation') {
            sql.prepare('INSERT INTO agent_subagent_observations(subagent_id,observing_run_id,observed_at) VALUES (?,?,?)').run(h.child.id, h.child.runId, now)
          } else if (kind === 'visible-child') sql.prepare('DELETE FROM agent_hidden_threads WHERE thread_id=?').run(h.child.threadId)
          else if (kind === 'live-thread-cleanup') sql.prepare('INSERT INTO agent_attachment_cleanup_outbox(thread_id) VALUES (?)').run(h.owner.threadId)
          else {
            const attachment = sql.prepare('SELECT id,thread_id,storage_path FROM agent_attachments WHERE id=?').get(h.attachment.id) as { id: string; thread_id: string; storage_path: string }
            sql.prepare('INSERT INTO agent_attachment_file_cleanup_outbox(attachment_id,thread_id,storage_path) VALUES (?,?,?)')
              .run(attachment.id, attachment.thread_id, attachment.storage_path)
          }
        })
        const error = kind.startsWith('managed-') ? 'SQLite integrity failure' : kind === 'child-observation' ? 'does not belong to its parent run'
          : kind === 'visible-child' ? 'invalid conversation relationship' : 'cannot be scheduled for'
        rejectWithoutChanging(h, error)
      } finally { h.dispose() }
    })
})
