import { restoreFrozenStorageDirectory } from '../test/frozenStorage'
import type { AgentThread, AgentRun, AgentRuntimeEvent } from '../shared/agentTypes'
import { NativeConversationDatabase } from './agent/nativeConversationDatabase'
import { NativeMessageReader } from './agent/nativeMessageReader'
import { NativeRuntimeCoordinator } from './agent/nativeRuntimeCoordinator'
import { conversationExecution } from '../runtime/conversationExecution'
import { FileChangeLedger } from './agent/fileChangeLedger'
import { SqliteMemoryStore } from './agent/memoryStore'
import { readThreadRecord } from './agent/conversationThreads'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import capabilities from '../../data/config/capabilities.json'
import projectDefaults from '../../data/config/projects.json'
import { DEFAULT_WORKSPACE_PROJECT_ID } from '@shared/types'
import { AgentStorage } from './agent/agentStorage'
import { getAgentCatalogFile, getAgentConversationDatabaseFile } from './config/dataDir'
import { inspectRecoveryRepair, repairRecoveryData } from './recoveryRepair'
import { preserveRecoveryData } from './recoveryData'
import { validateExecutionStorageDirectory } from './executionStorageValidation'
import { patchTextHash } from './filePatchRecord'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

interface FrozenRepair { thread: AgentThread; run?: AgentRun; target?: string; inverseRunId?: string; operationId?: string }

async function fixture(projectVersion = 4, variant = 'base') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'anas-project-repair-')))
  roots.push(root)
  const data = join(root, 'data')
  const metadata = await restoreFrozenStorageDirectory<FrozenRepair>('native-repair-' + variant, data)
  const { thread } = metadata
  const { version: _version, ...defaults } = projectDefaults
  const project = { ...defaults, id: DEFAULT_WORKSPACE_PROJECT_ID, kind: 'workspace', name: 'Keep project',
    pinned: false, collapsed: false, sourceFolders: ['/keep/source'], restrict_subagents: false,
    capabilities, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }
  const projects = { version: projectVersion, projects: [project] }
  await writeFile(join(data, 'db/projects.json'), JSON.stringify(projects))
  await mkdir(join(data, 'sqlite'), { recursive: true })
  await writeFile(join(data, 'sqlite/agent.sqlite'), 'unrelated historical data, preserved verbatim')
  const databases = [getAgentCatalogFile(data), getAgentConversationDatabaseFile(thread.id, data)]
  for (const path of databases) {
    const db = new Database(path)
    db.pragma('user_version = 99')
    db.close()
  }
  return { root, data, projects, databases, thread, metadata }
}

async function archivedChangeFixture(version: number | undefined, databaseVersion = 1, restore = false, deletedInverse = false) {
  const value = await fixture(0, deletedInverse ? 'deleted-inverse' : restore ? 'reversed' : 'forward')
  for (const file of value.databases) {
    const raw = new Database(file)
    raw.pragma('user_version = 1')
    raw.close()
  }
  const { run, inverseRunId, target: archivedTarget } = value.metadata
  if (!run) throw new Error('Frozen repair run is missing.')
  // Archived targets stay historical evidence. User content lives only in this fresh workspace.
  const target = join(value.root, 'edited.txt')
  await writeFile(target, restore ? 'before\n' : 'after\n')
  if (deletedInverse) {
    if (version !== 0 || databaseVersion !== 1 || !value.metadata.operationId) throw new Error('Deleted inverse fixture must retain its valid saved evidence.')
    return { ...value, run, target, archivedTarget, inverseRunId, operationId: value.metadata.operationId }
  }
  const raw = new Database(value.databases[1])
  try {
    const rows = raw.prepare('SELECT operation_id, definition_json, metadata_json FROM agent_file_changes').all() as Array<{
      operation_id: string; definition_json: string; metadata_json: string
    }>
    const definitions = new Map<string, string>()
    rows.sort((left, right) => Number(Boolean(JSON.parse(left.definition_json).restores)) - Number(Boolean(JSON.parse(right.definition_json).restores)))
    for (const row of rows) {
      const definition = { ...JSON.parse(row.definition_json), version }
      if (definition.restores) definition.restores.definitionHash = patchTextHash(definitions.get(definition.restores.operationId)!)
      definitions.set(row.operation_id, JSON.stringify(definition))
    }
    for (const row of rows) {
      const definition = definitions.get(row.operation_id)!
      const metadata = { ...JSON.parse(row.metadata_json), version, definitionHash: patchTextHash(definition) }
      for (const reference of [metadata.transaction.reverseAttempt, metadata.transaction.recovery?.inverse]) {
        if (reference) reference.definitionHash = patchTextHash(definitions.get(reference.operationId)!)
      }
      raw.prepare('UPDATE agent_file_changes SET definition_json = ?, metadata_json = ? WHERE operation_id = ?')
        .run(definition, JSON.stringify(metadata), row.operation_id)
    }
    raw.pragma(`user_version = ${databaseVersion}`)
    return { ...value, run, target, archivedTarget, inverseRunId, operationId: rows[0].operation_id }
  } finally { raw.close() }
}

describe('project version metadata recovery', () => {
  it.each([1, 2])('repairs an incompatible access mode constraint labelled catalog v%s without losing conversation data', async version => {
    const { root, data, databases, thread } = await fixture(0)
    for (const [index, path] of databases.entries()) {
      const db = new Database(path)
      db.pragma(`user_version = ${index === 0 ? version : 1}`)
      db.close()
    }
    const before = await Promise.all(databases.map(path => readFile(path)))
    await expect(validateExecutionStorageDirectory(data)).rejects.toThrow(version === 1 ? 'expected catalog 2' : 'access mode')
    const inspected = await inspectRecoveryRepair(data)
    expect(inspected.files.find(file => file.name === 'projects.json')?.repairableFields.join('\n')).toContain('access_mode')
    expect(await Promise.all(databases.map(path => readFile(path)))).toEqual(before)
    const result = await repairRecoveryData(data, 'projects.json', () => preserveRecoveryData(data, root))
    expect(result.unresolved).toEqual([])
    expect(await readFile(join(result.preservationPath!, 'data/db/catalog.sqlite'))).toEqual(before[0])
    expect(await readFile(databases[1])).toEqual(before[1])
    await expect(validateExecutionStorageDirectory(data)).resolves.toBeUndefined()
    const storage = AgentStorage.openNative(data)
    try {
      expect(storage.getThread(thread.id)).toMatchObject({ title: thread.title, accessMode: 'smart_approval' })
      expect(storage.conversationForThread(thread.id).getThread(thread.id)?.accessMode).toBe('smart_approval')
      expect((await storage.memoryStore.searchMemories({ scope: 'global' })).items[0].content).toBe('Preserve this memory')
      const created = storage.createThread({ title: 'New smart conversation' })
      expect(created.accessMode).toBe('smart_approval')
      expect(storage.getThread(created.id)?.accessMode).toBe('smart_approval')
      for (const mode of ['strict_approval', 'full_access', 'smart_approval'] as const) {
        expect(storage.setAccessMode(created.id, mode).accessMode).toBe(mode)
      }
    } finally { storage.close() }
    const preserve = vi.fn(async () => '/unused')
    expect((await repairRecoveryData(data, 'projects.json', preserve)).repaired).toEqual([])
    expect(preserve).not.toHaveBeenCalled()
  })

  it('preserves nested plugin state and private files when replacing project storage', async () => {
    const { root, data, thread } = await fixture()
    const pluginData = join(data, 'db/plugins/test-plugin')
    await mkdir(pluginData, { recursive: true })
    const files = { 'state.json': Buffer.from('{"version":0,"values":{"draft":"keep"}}'),
      'private.sqlite': Buffer.from([0, 255, 13, 10, 32]) }
    for (const [name, bytes] of Object.entries(files)) await writeFile(join(pluginData, name), bytes)
    const preservedFiles = ['db/input_history.json', `db/conversations/${thread.id}/tool_results/result.txt`,
      'conversations/obsolete/conversation.sqlite']
    for (const name of preservedFiles) {
      await mkdir(dirname(join(data, name)), { recursive: true })
      await writeFile(join(data, name), `keep ${name}`)
    }
    const result = await repairRecoveryData(data, 'projects.json', () => preserveRecoveryData(data, root))
    expect(result.unresolved).toEqual([])
    expect(JSON.parse(await readFile(join(data, 'db/projects.json'), 'utf8')).version).toBe(0)
    for (const [name, bytes] of Object.entries(files)) expect(await readFile(join(pluginData, name))).toEqual(bytes)
    for (const name of preservedFiles) expect(await readFile(join(data, name), 'utf8')).toBe(`keep ${name}`)
    const database = new Database(getAgentConversationDatabaseFile(thread.id, data), { readonly: true })
    try { expect(readThreadRecord(database, thread.id)?.title).toBe('Keep conversation') } finally { database.close() }
  })

  it.each([undefined, 7])('repairs archived file records with version %s and preserves a usable conversation', async version => {
    const { root, data, databases, thread, run, target, archivedTarget } = await archivedChangeFixture(version, version === undefined ? 1 : 0)
    const original = await readFile(databases[1])
    await writeFile(target, 'Later user edit; do not replay the old patch.\n')
    const plan = await inspectRecoveryRepair(data)
    expect(plan.files.find(file => file.name === 'projects.json')?.error).toBeUndefined()
    expect(plan.files.find(file => file.name === 'projects.json')?.repairableFields.join('\n')).toContain('agent_file_changes')
    expect(await readFile(databases[1])).toEqual(original)
    const result = await repairRecoveryData(data, 'projects.json', () => preserveRecoveryData(data, root))
    expect(result.unresolved).toEqual([])
    expect(await readFile(join(result.preservationPath!, 'data/db/conversations', thread.id, 'conversation.sqlite'))).toEqual(original)
    NativeConversationDatabase.validateBackup(databases[1], join(data, 'db', 'conversations', thread.id, 'attachments'), new Set([thread.projectId]), thread.id)
    const preserve = vi.fn(async () => '/unused')
    expect((await repairRecoveryData(data, 'projects.json', preserve)).repaired).toEqual([])
    expect(preserve).not.toHaveBeenCalled()

    const storage = AgentStorage.openNative(data), events: AgentRuntimeEvent[] = []
    const coordinator = new NativeRuntimeCoordinator(storage, { push: event => { events.push(event) } }, { prepareWorkspace: false })
    try {
      const snapshot = await coordinator.getSnapshot(thread.id)
      expect(snapshot.messages.some(message => JSON.stringify(message.content).includes('Keep my original message'))).toBe(true)
      const database = storage.conversationForThread(thread.id)
      expect(database.runs.store.readHistory(thread.id)?.messages.some(message => message.value.content === 'Keep my original message')).toBe(true)
      const changes = database.resources.fileChanges.queryRoundFiles({ runId: run.id })
      expect(database.resources.fileChanges.readRoundContent({ runId: run.id, version: changes.version, filePath: archivedTarget! }))
        .toMatchObject({ status: 'ready', before: 'before\n', after: 'after\n' })
      const submission = await coordinator.forThread(thread.id).submitRunWithAttachments({
        submissionId: randomUUID(), runId: randomUUID(), threadId: thread.id, text: 'Continue this conversation'
      }, async () => ({ execution: conversationExecution({
        store: database.runs.store, enter: database.execution.enter,
        prepareModel: async state => ({ kind: 'model', invoke: async () => ({
          message: { id: 'new-answer', value: { id: 'new-answer', kind: 'assistant', content: 'Continued', context: { runId: state.runId } } },
          calls: [], context: { ...state.context, modelCalls: state.context.modelCalls + 1 } }) }),
        afterModel: async () => ({ kind: 'complete' }), prepareTools: async () => ({ calls: [] }),
        executeTool: async () => { throw new Error('No previous file effect may execute') },
        directions: async () => [], drain: async () => {}, retry: { maxRetries: 0 }
      }), dispose: async () => {} }))
      expect((await submission.handle!.completed).status).toBe('completed')
      await submission.handle!.drained
      expect(events.some(event => event.type === 'run_completed')).toBe(true)
      expect((await coordinator.getSnapshot(thread.id)).messages.length).toBeGreaterThan(snapshot.messages.length)
      await coordinator.deleteThread(thread.id)
      expect(storage.getThread(thread.id)).toBeNull()
      await expect(readFile(databases[1])).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(target, 'utf8')).toBe('Later user edit; do not replay the old patch.\n')
    } finally { await coordinator.shutdown(); storage.close() }
  })

  it('keeps archived forward and reverse operations linked without replaying either', async () => {
    const { root, data, databases, run, target, operationId } = await archivedChangeFixture(undefined, 1, true)
    await writeFile(target, 'Keep the current user content')
    const result = await repairRecoveryData(data, 'projects.json', () => preserveRecoveryData(data, root))
    expect(result.unresolved).toEqual([])
    const database = new Database(databases[1], { readonly: true })
    try {
      new FileChangeLedger(database).validateIntegrity()
      const source = (await new FileChangeLedger(database).load(run.id, operationId))!
      const inverseReference = source.transaction.recovery!.inverse!
      const inverse = (await new FileChangeLedger(database).load(inverseReference.requestId, inverseReference.operationId))!
      expect(source.transaction.state).toBe('resolved')
      expect(inverse.transaction.state).toBe('resolved')
      expect(inverse.transaction.restores?.definitionHash).toBe(source.definitionHash)
      expect(source.transaction.reverseAttempt?.definitionHash).toBe(inverse.definitionHash)
      expect(source.transaction.recovery?.inverse?.definitionHash).toBe(inverse.definitionHash)
      expect(await readFile(target, 'utf8')).toBe('Keep the current user content')
    } finally { database.close() }
  })

  it.each(['metadata', 'definition'])('handles a deleted inverse round during %s version repair', async field => {
    const { root, data, databases, thread, run, operationId } = await archivedChangeFixture(0, 1, true, true)
    NativeConversationDatabase.validateBackup(databases[1], join(data, 'db', 'conversations', thread.id, 'attachments'), new Set([thread.projectId]), thread.id)
    const raw = new Database(databases[1])
    let row: { definition_json: string; metadata_json: string }
    try {
      row = raw.prepare('SELECT definition_json, metadata_json FROM agent_file_changes WHERE operation_id = ?').get(operationId) as typeof row
      const definition = JSON.parse(row.definition_json), metadata = JSON.parse(row.metadata_json)
      if (field === 'definition') delete definition.version
      else delete metadata.version
      const text = field === 'definition' ? JSON.stringify(definition) : row.definition_json
      metadata.definitionHash = patchTextHash(text)
      raw.prepare('UPDATE agent_file_changes SET definition_json = ?, metadata_json = ? WHERE operation_id = ?')
        .run(text, JSON.stringify(metadata), operationId)
    } finally { raw.close() }
    const original = await readFile(databases[1])
    const result = await repairRecoveryData(data, 'projects.json', () => preserveRecoveryData(data, root))
    expect(await readFile(join(result.preservationPath!, 'data/db/conversations', thread.id, 'conversation.sqlite'))).toEqual(original)
    if (field === 'definition') {
      expect(result.unresolved.join('\n')).toContain('unavailable in this archive')
      expect(await readFile(databases[1])).toEqual(original)
      return
    }
    expect(result.unresolved).toEqual([])
    NativeConversationDatabase.validateBackup(databases[1], join(data, 'db', 'conversations', thread.id, 'attachments'), new Set([thread.projectId]), thread.id)
    const repaired = new Database(databases[1], { readonly: true })
    try {
      const current = repaired.prepare('SELECT definition_json, metadata_json FROM agent_file_changes WHERE operation_id = ?').get(operationId) as typeof row
      expect(current.definition_json).toBe(row.definition_json)
      expect(JSON.parse(current.metadata_json)).toEqual(JSON.parse(row.metadata_json))
      expect(repaired.prepare('SELECT count(*) AS count FROM agent_file_changes').get()).toEqual({ count: 1 })
    } finally { repaired.close() }
    const database = new Database(databases[1], { readonly: true })
    try {
      expect((await new FileChangeLedger(database).load(run.id, operationId))?.transaction.state).toBe('resolved')
      expect(JSON.stringify(new NativeMessageReader(database).window(thread.id).messages)).toContain('Keep my original message')
    } finally { database.close() }
    const storage = AgentStorage.openNative(data), coordinator = new NativeRuntimeCoordinator(storage, { push: () => {} })
    try {
      await coordinator.deleteThread(thread.id)
      expect(storage.getThread(thread.id)).toBeNull()
      await expect(readFile(databases[1])).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await coordinator.shutdown(); storage.close() }
  })

  it('preserves an absent source reference when repairing only inverse metadata', async () => {
    const { root, data, databases, run, inverseRunId, operationId } = await archivedChangeFixture(0, 0, true)
    const raw = new Database(databases[1])
    let definition: string
    let inverseId: string
    try {
      const source = JSON.parse((raw.prepare('SELECT metadata_json FROM agent_file_changes WHERE operation_id = ?').get(operationId) as { metadata_json: string }).metadata_json)
      inverseId = source.transaction.recovery.inverse.operationId
      definition = (raw.prepare('SELECT definition_json FROM agent_file_changes WHERE operation_id = ?').get(inverseId) as { definition_json: string }).definition_json
      raw.prepare('DELETE FROM agent_file_changes WHERE request_id = ?').run(run.id)
      raw.exec("UPDATE agent_file_changes SET metadata_json = json_set(metadata_json, '$.version', 7)")
    } finally { raw.close() }
    const result = await repairRecoveryData(data, 'projects.json', () => preserveRecoveryData(data, root))
    expect(result.unresolved).toEqual([])
    const database = new Database(databases[1], { readonly: true })
    try {
      const inverse = (await new FileChangeLedger(database).load(inverseRunId!, inverseId))!
      expect(inverse.definitionHash).toBe(patchTextHash(definition))
      expect(inverse.transaction.restores).toEqual(JSON.parse(definition).restores)
      expect(inverse.transaction.sourceFinalized).toBe(true)
    } finally { database.close() }
  })

  it('still rejects a mismatched reference to an available archived operation', async () => {
    const { root, data, databases, operationId } = await archivedChangeFixture(0, 0, true)
    const raw = new Database(databases[1])
    try {
      raw.prepare("UPDATE agent_file_changes SET metadata_json = json_set(metadata_json, '$.version', 7, '$.transaction.reverseAttempt.definitionHash', ?) WHERE operation_id = ?")
        .run('0'.repeat(64), operationId)
    } finally { raw.close() }
    const original = await readFile(databases[1])
    const result = await repairRecoveryData(data, 'projects.json', () => preserveRecoveryData(data, root))
    expect(result.unresolved.join('\n')).toContain('invalid definition hash')
    expect(await readFile(databases[1])).toEqual(original)
  })

  it.each(['hash', 'snapshot'])('does not cover up damaged file %s evidence with a new format version', async fault => {
    const { root, data, databases } = await archivedChangeFixture(undefined)
    const raw = new Database(databases[1])
    if (fault === 'hash') raw.prepare("UPDATE agent_file_changes SET metadata_json = json_set(metadata_json, '$.definitionHash', ?)").run('0'.repeat(64))
    else raw.exec("UPDATE agent_file_change_contents SET content = 'damaged snapshot'")
    raw.close()
    const original = await readFile(databases[1])
    const result = await repairRecoveryData(data, 'projects.json', () => preserveRecoveryData(data, root))
    expect(result.unresolved.join('\n')).toContain(fault === 'hash' ? 'inconsistent evidence' : 'snapshot is damaged')
    expect(result.preservationPath).toBeTruthy()
    expect(await readFile(databases[1])).toEqual(original)
  })

  it('does not split an archive from still-present file recovery material', async () => {
    const { root, data, databases, thread, run, operationId } = await archivedChangeFixture(undefined)
    const recoveryDirectory = join(data, 'db', 'conversations', thread.id, 'file_edits', run.id, operationId)
    await mkdir(recoveryDirectory, { recursive: true })
    await writeFile(join(recoveryDirectory, 'record.json'), 'preserve this recovery material')
    const original = await readFile(databases[1])
    const result = await repairRecoveryData(data, 'projects.json', () => preserveRecoveryData(data, root))
    expect(result.unresolved.join('\n')).toContain('still has recovery material')
    expect(await readFile(databases[1])).toEqual(original)
    expect(await readFile(join(recoveryDirectory, 'record.json'), 'utf8')).toBe('preserve this recovery material')
  })

  it('rejects replacement if recovery material appears after inspection', async () => {
    const { data, databases, thread, run, operationId } = await archivedChangeFixture(undefined)
    const original = await readFile(databases[1])
    await expect(repairRecoveryData(data, 'projects.json', async () => {
      await mkdir(join(data, 'db', 'conversations', thread.id, 'file_edits', run.id, operationId), { recursive: true })
      return '/preserved'
    })).rejects.toThrow('changed since inspection')
    expect(await readFile(databases[1])).toEqual(original)
  })

  it('preserves an orphan deletion stage before repairing project and database versions', async () => {
    const { root, data, projects, databases, thread } = await fixture()
    const stagePath = join(data, 'db/project-deletion.stage.json')
    const stage = `${JSON.stringify({ ...projects, version: 0 }, null, 2)}\n`
    await writeFile(stagePath, stage)
    const originals = await Promise.all(databases.map(path => readFile(path)))
    const plan = await inspectRecoveryRepair(data)
    expect(plan.files.find(file => file.name === 'projects.json')?.error).toBeUndefined()
    const preserve = vi.fn(async () => {
      expect(await readFile(stagePath, 'utf8')).toBe(stage)
      expect(JSON.parse(await readFile(join(data, 'db/projects.json'), 'utf8'))).toEqual(projects)
      for (const [index, path] of databases.entries()) expect(await readFile(path)).toEqual(originals[index])
      return preserveRecoveryData(data, root)
    })
    const result = await repairRecoveryData(data, 'projects.json', preserve)
    expect(preserve).toHaveBeenCalledOnce()
    expect(result.repaired).toHaveLength(4)
    expect(result.unresolved).toEqual([])
    expect(await readFile(stagePath, 'utf8')).toBe(stage)
    expect(await readFile(join(result.preservationPath!, 'data/db/project-deletion.stage.json'), 'utf8')).toBe(stage)
    expect(JSON.parse(await readFile(join(data, 'db/projects.json'), 'utf8'))).toEqual({ ...projects, version: 0 })
    const database = new Database(getAgentConversationDatabaseFile(thread.id, data), { readonly: true })
    try { expect(readThreadRecord(database, thread.id)?.title).toBe('Keep conversation') } finally { database.close() }
  })

  it('leaves a journaled deletion transaction intact instead of treating it as an orphan stage', async () => {
    const { root, data, projects, databases } = await fixture()
    const previous = { version: 0, projects: [...projects.projects, { ...projects.projects[0], id: 'pending-project' }] }
    const next = { ...projects, version: 0 }
    const journal = { version: 0, projectId: 'pending-project', threadIds: [], previous, next }
    const paths = [join(data, 'db/projects.json'), join(data, 'db/project-deletion.stage.json'), join(data, 'db/project-deletion.json'), ...databases]
    await writeFile(paths[0], JSON.stringify({ ...previous, version: projects.version }))
    await writeFile(paths[1], JSON.stringify(next))
    await writeFile(paths[2], JSON.stringify(journal))
    const originals = await Promise.all(paths.map(path => readFile(path)))
    const result = await repairRecoveryData(data, 'projects.json', () => preserveRecoveryData(data, root))
    expect(result.repaired).toEqual([])
    expect(result.unresolved.join('\n')).toContain('Project deletion recovery must finish')
    for (const [index, path] of paths.entries()) {
      expect(await readFile(path)).toEqual(originals[index])
      expect(await readFile(join(result.preservationPath!, 'data', path.slice(data.length + 1)))).toEqual(originals[index])
    }
  })

  it('salvages conversation versions but reports a missing catalog without inventing one', async () => {
    const { root, data, databases } = await fixture()
    await rm(databases[0])
    const result = await repairRecoveryData(data, 'projects.json', () => preserveRecoveryData(data, root))
    expect(result.repaired).toHaveLength(2)
    expect(result.unresolved.join('\n')).toContain('Catalog database is missing')
    await expect(readFile(databases[0])).rejects.toMatchObject({ code: 'ENOENT' })
    const db = new Database(databases[1], { readonly: true })
    try { expect(db.pragma('user_version', { simple: true })).toBe(1) } finally { db.close() }
  })

  it('validates a copied WAL without checkpointing or changing the original database', async () => {
    const { data, databases } = await fixture()
    const db = new Database(databases[1])
    try {
      db.pragma('journal_mode = WAL')
      db.pragma('wal_autocheckpoint = 0')
      db.pragma('user_version = 9')
      const before = await readFile(databases[1]), wal = await readFile(`${databases[1]}-wal`)
      const plan = await inspectRecoveryRepair(data)
      const status = plan.files.find(file => file.name === 'projects.json')!
      expect(status.error).toBeUndefined()
      expect(status.repairableFields.some(field => field.endsWith('user_version (9 → 1)'))).toBe(true)
      expect(await readFile(databases[1])).toEqual(before)
      expect(await readFile(`${databases[1]}-wal`)).toEqual(wal)
    } finally { db.close() }
  })

  it.each([0, 4])('repairs catalog and every conversation together with project version %s', async version => {
    const { root, data, projects, databases, thread } = await fixture(version)
    const originalConversation = new Database(databases[1], { readonly: true })
    let originalMessages: ReturnType<NativeMessageReader['window']>['messages']
    try { originalMessages = new NativeMessageReader(originalConversation).window(thread.id).messages }
    finally { originalConversation.close() }
    const history = '{"version":0,"maxHistory":100,"items":[]}'
    await writeFile(join(data, 'db/input_history.json'), history)
    const before = await Promise.all(databases.map(path => readFile(path)))
    const inspected = await inspectRecoveryRepair(data)
    const status = inspected.files.find(file => file.name === 'projects.json')!
    expect(status.error).toBeUndefined()
    expect(status.repairableFields).toHaveLength(version === 0 ? 3 : 4)
    for (const [index, path] of databases.entries()) expect(await readFile(path)).toEqual(before[index])
    const result = await repairRecoveryData(data, 'projects.json', () => preserveRecoveryData(data, root))
    expect(result.unresolved).toEqual([])
    expect(await readFile(join(data, 'sqlite/agent.sqlite'), 'utf8')).toBe('unrelated historical data, preserved verbatim')
    expect(JSON.parse(await readFile(join(data, 'db/projects.json'), 'utf8'))).toEqual({ ...projects, version: 0 })
    expect(await readFile(join(data, 'db/input_history.json'), 'utf8')).toBe(history)
    expect(JSON.parse(await readFile(join(result.preservationPath!, 'data/db/projects.json'), 'utf8'))).toEqual(projects)
    for (const [index, path] of databases.entries()) {
      const db = new Database(path, { readonly: true })
      try { expect(db.pragma('user_version', { simple: true })).toBe(index === 0 ? 2 : 1) } finally { db.close() }
      const saved = join(result.preservationPath!, 'data', path.slice(data.length + 1))
      expect(await readFile(saved)).toEqual(before[index])
    }
    const conversation = new Database(databases[1], { readonly: true }), catalog = new Database(databases[0], { readonly: true })
    try {
      expect(readThreadRecord(conversation, thread.id)?.title).toBe('Keep conversation')
      expect(conversation.prepare('SELECT status FROM agent_runs WHERE id = ?').get('kept-run')).toEqual({ status: 'completed' })
      expect(new NativeMessageReader(conversation).window(thread.id).messages).toEqual(originalMessages)
      expect((await new SqliteMemoryStore(catalog).searchMemories({ scope: 'global' })).items[0].content).toBe('Preserve this memory')
    } finally { conversation.close(); catalog.close() }
    const preserve = vi.fn(async () => '/unused')
    expect((await repairRecoveryData(data, 'projects.json', preserve)).repaired).toEqual([])
    expect(preserve).not.toHaveBeenCalled()
    expect((await readdir(root)).some(name => name.startsWith('.anas-restore-'))).toBe(false)
  })

  it.each(['schema', 'reference'])('salvages independent data while preserving the database with invalid %s', async fault => {
    const { root, data, databases } = await fixture()
    const db = new Database(databases[fault === 'schema' ? 1 : 0])
    if (fault === 'schema') db.exec('ALTER TABLE agent_runs RENAME COLUMN error TO old_error')
    else db.exec("UPDATE agent_conversations SET project_id = 'missing-project'")
    db.close()
    const before = await Promise.all([join(data, 'db/projects.json'), ...databases].map(path => readFile(path)))
    const preserve = vi.fn(() => preserveRecoveryData(data, root))
    const result = await repairRecoveryData(data, 'projects.json', preserve)
    expect(result.repaired).toHaveLength(fault === 'schema' ? 3 : 2)
    expect(result.unresolved.join('\n')).toContain(fault === 'schema' ? 'Invalid native conversation schema' : 'missing project')
    expect(preserve).toHaveBeenCalledOnce()
    const damagedIndex = fault === 'schema' ? 1 : 0
    expect(await readFile(databases[damagedIndex])).toEqual(before[damagedIndex + 1])
    expect(JSON.parse(await readFile(join(data, 'db/projects.json'), 'utf8')).version).toBe(0)
    for (const [index, path] of [join(data, 'db/projects.json'), ...databases].entries()) {
      expect(await readFile(join(result.preservationPath!, 'data', path.slice(data.length + 1)))).toEqual(before[index])
    }
  })

  it('leaves all originals intact if preservation fails or data changes during preservation', async () => {
    const { data, databases } = await fixture()
    const paths = [join(data, 'db/projects.json'), ...databases]
    const before = await Promise.all(paths.map(path => readFile(path)))
    await expect(repairRecoveryData(data, 'projects.json', async () => { throw new Error('disk full') })).rejects.toThrow('disk full')
    for (const [index, path] of paths.entries()) expect(await readFile(path)).toEqual(before[index])
    await expect(repairRecoveryData(data, 'projects.json', async () => {
      const db = new Database(databases[0]); db.exec("UPDATE agent_conversations SET title='external change'"); db.close()
      return '/preserved'
    })).rejects.toThrow('changed since inspection')
    expect(await readFile(paths[0])).toEqual(before[0])
    expect(await readFile(paths[2])).toEqual(before[2])
  })
})
