import { defaultCapabilities } from '@shared/agentCapabilities'
import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { SqliteMemoryStore } from './memoryStore'
import { FileEditStore } from '../fileEditStore'

const globals: Database.Database[] = []
afterEach(() => { for (const global of globals.splice(0)) global.close() })
function openDatabase(file: string) {
  const global = new Database(':memory:'); globals.push(global)
  return NativeConversationDatabase.open(file, { attachmentRoot: join(dirname(file), 'attachments'),
    memoryStore: new SqliteMemoryStore(global), fileEditStore: new FileEditStore(join(dirname(file), 'file_edits')) })
}
function createRun(database: NativeConversationDatabase, threadId: string, runId: string) {
  return database.runs.createRun({ threadId, runId, operation: 'agent', message: {
    id: runId + ':input', value: { id: runId + ':input', kind: 'user', content: 'Run', context: { runId } }
  } })
}

describe('native durable run configuration', () => {
  it.each(['running', 'completed', 'unconfirmed'] as const)('persists cleanup %s separately and stops stale progress after reopening', async (status) => {
    const root = await mkdtemp(join(tmpdir(), 'anas-cleanup-report-'))
    const file = join(root, 'agent.sqlite')
    let database: NativeConversationDatabase | undefined
    try {
      database = openDatabase(file)
      const thread = database.createThread()
      const run = createRun(database, thread.id, 'cleanup-report-run')
      const identity = { threadId: thread.id, runId: run.id }
      await database.runs.enter('input', identity)
      database.runs.store.finish({ ...identity, expectedRevisionId: database.runs.store.load(thread.id)!.revisionId }, 'completed')
      database.background.updateRunBackgroundCleanup(run.id, { status, report: 'Cleanup detail' })
      expect(database.messages.activities.getRun(run.id)?.error).toBeUndefined()
      expect(database.readSnapshot(thread.id, { settlingRunId: run.id }).activities[0].backgroundCleanup).toEqual({ status, report: 'Cleanup detail' })
      const withoutOwner = database.readSnapshot(thread.id).activities[0].backgroundCleanup
      expect(withoutOwner?.status).toBe(status === 'running' ? 'unconfirmed' : status)
      expect(withoutOwner?.report).toContain('Cleanup detail')
      expect(database.messages.activities.getRun(run.id)?.backgroundCleanup).toEqual({ status, report: 'Cleanup detail' })
      database.close()
      database = openDatabase(file)
      database.recover()
      const cleanup = database.messages.activities.getRun(run.id)?.backgroundCleanup
      expect(cleanup?.status).toBe(status === 'running' ? 'unconfirmed' : status)
      expect(cleanup?.report).toContain('Cleanup detail')
      expect(database.messages.activities.getRun(run.id)?.status).toBe('completed')
      expect(database.messages.activities.getRun(run.id)?.error).toBeUndefined()
    } finally { database?.close(); await rm(root, { recursive: true, force: true }) }
  })

  it.each([false, true])('freezes coding mode %s across database reopening', async (codingMode) => {
    const root = await mkdtemp(join(tmpdir(), 'anas-coding-snapshot-'))
    const file = join(root, 'agent.sqlite')
    let database: NativeConversationDatabase | undefined
    try {
      database = openDatabase(file)
      const thread = database.createThread({ title: 'Coding snapshot' })
      const run = createRun(database, thread.id, 'coding-run')
      const configuration = { customTools: [], codingMode, capabilities: structuredClone(defaultCapabilities) }
      database.runs.resolveRunConfiguration({ threadId: thread.id, runId: run.id }, configuration)
      database.close()
      database = openDatabase(file)
      expect(database.runs.getRunConfiguration({ threadId: thread.id, runId: run.id })).toEqual(configuration)
      expect(() => database!.runs.resolveRunConfiguration({ threadId: thread.id, runId: run.id }, { ...configuration, codingMode: !codingMode })).toThrow('already fixed')
      const raw = new Database(file, { readonly: true })
      try {
        const row = raw.prepare('SELECT configuration_json FROM agent_runs WHERE id = ?').get(run.id) as { configuration_json: string }
        expect(JSON.parse(row.configuration_json)).toMatchObject({ coding_mode: codingMode })
        expect(JSON.parse(row.configuration_json)).not.toHaveProperty('codingMode')
      } finally { raw.close() }
    } finally { database?.close(); await rm(root, { recursive: true, force: true }) }
  })

  it.each([true, false])('persists and freezes a resolved background setting of %s', async (enabled) => {
    const root = await mkdtemp(join(tmpdir(), 'anas-agent-run-setting-'))
    const file = join(root, 'agent.sqlite')
    let current: NativeConversationDatabase | undefined
    try {
      current = openDatabase(file)
      const thread = current.createThread({ title: 'Durable run setting' })
      const run = createRun(current, thread.id, 'durable-setting-run')
      expect(current.runs.getRunConfiguration({ threadId: thread.id, runId: run.id })?.capabilities.backgroundTools).toBeUndefined()
      current.runs.resolveRunConfiguration({ threadId: thread.id, runId: run.id }, { customTools: [], codingMode: false, capabilities: { ...structuredClone(defaultCapabilities), backgroundTools: enabled } })
      current.runs.resolveRunConfiguration({ threadId: thread.id, runId: run.id }, { customTools: [], codingMode: false, capabilities: { ...structuredClone(defaultCapabilities), backgroundTools: enabled } })
      expect(() => current!.runs.resolveRunConfiguration({ threadId: thread.id, runId: run.id }, { customTools: [], codingMode: false, capabilities: { ...structuredClone(defaultCapabilities), backgroundTools: !enabled } })).toThrow('already fixed')
      expect(current.runs.getRunConfiguration({ threadId: thread.id, runId: run.id })?.capabilities.backgroundTools).toBe(enabled)
      current.close()
      current = openDatabase(file)
      expect(current.runs.getRunConfiguration({ threadId: thread.id, runId: run.id })?.capabilities.backgroundTools).toBe(enabled)
      expect(() => current!.runs.resolveRunConfiguration({ threadId: thread.id, runId: run.id }, { customTools: [], codingMode: false, capabilities: { ...structuredClone(defaultCapabilities), backgroundTools: !enabled } })).toThrow('already fixed')
      expect(() => current!.runs.resolveRunConfiguration({ threadId: thread.id, runId: 'missing-run' }, { customTools: [], codingMode: false, capabilities: { ...structuredClone(defaultCapabilities), backgroundTools: enabled } })).toThrow('does not belong to this conversation')
    } finally {
      current?.close()
      await rm(root, { recursive: true, force: true })
    }
  })


})
