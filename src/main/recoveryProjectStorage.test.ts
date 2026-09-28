import Database from 'better-sqlite3'
import { HumanMessage } from '@langchain/core/messages'
import { createDeepAgent } from 'deepagents'
import { FakeToolCallingModel } from 'langchain'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import capabilities from '../../data/config/capabilities.json'
import projectDefaults from '../../data/config/projects.json'
import { DEFAULT_WORKSPACE_PROJECT_ID } from '@shared/types'
import { AgentStorage } from './agent/agentStorage'
import { getAgentCatalogFile, getAgentConversationDatabaseFile } from './config/dataDir'
import { inspectRecoveryRepair, repairRecoveryData } from './recoveryRepair'
import { preserveRecoveryData } from './recoveryData'
import { AgentDatabase } from './agent/agentDatabase'
import { AgentRuntime } from './agent/agentRuntime'
import { AgentRuntimeCoordinator } from './agent/agentRuntimeCoordinator'
import { createAgentRunLifecycleMiddleware } from './agent/runLifecycleMiddleware'
import { runWithCurrentAgentToolEffect } from './agent/toolEffectScope'
import { FileEditStore } from './fileEditStore'
import { resolveFilePatchTargets } from './filePatch'
import { captureFilePatchPreimages } from './filePatchState'
import { asPatchInput } from './filePatchTestFixtures'
import { patchTextHash } from './filePatchRecord'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(projectVersion = 4) {
  const root = await mkdtemp(join(tmpdir(), 'anas-project-repair-'))
  roots.push(root)
  const data = join(root, 'data')
  await mkdir(join(data, 'config'), { recursive: true })
  for (const name of ['settings', 'models', 'tools', 'skills', 'subagents', 'mcp_servers', 'capabilities']) {
    await writeFile(join(data, `config/${name}.json`), await readFile(join(process.cwd(), `data/config/${name}.json`)))
  }
  const { version: _version, ...defaults } = projectDefaults
  const project = { ...defaults, id: DEFAULT_WORKSPACE_PROJECT_ID, kind: 'workspace', name: 'Keep project',
    pinned: false, collapsed: false, sourceFolders: ['/keep/source'], restrict_subagents: false,
    capabilities, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }
  const projects = { version: projectVersion, projects: [project] }
  await writeFile(join(data, 'projects.json'), JSON.stringify(projects))
  const storage = AgentStorage.open(data)
  const thread = storage.createThread({ title: 'Keep conversation' })
  const conversation = storage.conversationForThread(thread.id)
  const run = conversation.createRun(thread.id, 'kept-run')
  await conversation.checkpointer.put({ configurable: { thread_id: thread.id, checkpoint_ns: '' } }, {
    v: 4, id: 'kept-checkpoint', ts: '2026-09-01T00:00:00Z', channel_values: { anasRunLifecycle: { runId: run.id, status: 'completed' } },
    channel_versions: {}, versions_seen: {}
  }, { source: 'loop', step: 0, parents: {} })
  conversation.finishRun(run.id, 'completed')
  await storage.memoryStore.saveMemory({ scope: 'global', kind: 'fact', content: 'Preserve this memory', keywords: ['keep'], importance: 3 }, { origin: 'user' })
  storage.refreshConversation(thread.id)
  storage.close()
  await writeFile(join(data, 'sqlite/agent.sqlite'), 'unrelated historical data, preserved verbatim')
  const databases = [getAgentCatalogFile(data), getAgentConversationDatabaseFile(thread.id, data)]
  for (const path of databases) {
    const db = new Database(path)
    db.pragma('user_version = 1')
    db.close()
  }
  return { root, data, projects, databases, thread }
}

async function archivedChangeFixture(version: number | undefined, databaseVersion = 1, restore = false) {
  const value = await fixture(0)
  for (const file of value.databases) {
    const raw = new Database(file)
    raw.pragma('user_version = 0')
    raw.close()
  }
  const storage = AgentStorage.open(value.data)
  const database = storage.conversationForThread(value.thread.id)
  const run = database.createRun(value.thread.id, randomUUID())
  const store = new FileEditStore(join(value.data, 'file_edits'))
  const target = join(value.root, 'edited.txt')
  let inverseRunId: string | undefined
  const finishRun = async (runId: string) => {
    await database.checkpointer.put({ configurable: { thread_id: value.thread.id, checkpoint_ns: '' } }, {
      v: 4, id: randomUUID(), ts: new Date().toISOString(), channel_versions: {}, versions_seen: {},
      channel_values: { messages: [new HumanMessage({ id: 'original-message', content: 'Keep my original message',
        additional_kwargs: { anas_run_id: run.id } })], anasRunLifecycle: { runId, status: 'completed' } }
    }, { source: 'loop', step: 1, parents: {} })
    database.finishRun(runId, 'completed')
  }
  try {
    await writeFile(target, 'before\n')
    const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [
      { type: 'update', path: target, patch: '@@\n-before\n+after\n' }
    ] }), value.root)
    const images = await captureFilePatchPreimages(resolved.targets)
    await runWithCurrentAgentToolEffect({
      persistFileChange: (record, observed) => database.fileChanges.persist(record, observed), arm: () => undefined
    }, async () => {
      const source = await store.executePatch(resolved.input, images, run.id, { operationId: randomUUID() })
      if (restore) {
        await finishRun(run.id)
        inverseRunId = database.createRun(value.thread.id, randomUUID()).id
        const inverse = await store.restorePatch(source.operationId, run.id, inverseRunId, async () => {}, { operationId: randomUUID() })
        await store.finalizePatchRestore(source.operationId, run.id, async () => {}, {
          inverse: { requestId: inverseRunId, operationId: inverse!.operationId }
        })
        await finishRun(inverseRunId)
        await store.deleteFileEditRecordsForRequest(inverseRunId)
      }
      await store.deleteFileEditRecordsForRequest(run.id)
    })
    if (!restore) await finishRun(run.id)
  } finally { storage.close() }
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
    return { ...value, run, target, inverseRunId, operationId: rows[0].operation_id }
  } finally { raw.close() }
}

describe('project version metadata recovery', () => {
  it.each([undefined, 7])('repairs archived file records with version %s and preserves a usable conversation', async version => {
    const { root, data, databases, thread, run, target } = await archivedChangeFixture(version, version === undefined ? 1 : 0)
    const original = await readFile(databases[1])
    await writeFile(target, 'Later user edit; do not replay the old patch.\n')
    const plan = await inspectRecoveryRepair(data)
    expect(plan.files.find(file => file.name === 'projects.json')?.error).toBeUndefined()
    expect(plan.files.find(file => file.name === 'projects.json')?.repairableFields.join('\n')).toContain('agent_file_changes')
    expect(await readFile(databases[1])).toEqual(original)
    const result = await repairRecoveryData(data, 'projects.json', () => preserveRecoveryData(data, root))
    expect(result.unresolved).toEqual([])
    expect(await readFile(join(result.preservationPath!, 'data/sqlite/conversations', `${thread.id}.sqlite`))).toEqual(original)
    AgentDatabase.validateBackup(databases[1], join(data, 'attachments'), new Set([thread.projectId]), thread.id)
    const preserve = vi.fn(async () => '/unused')
    expect((await repairRecoveryData(data, 'projects.json', preserve)).repaired).toEqual([])
    expect(preserve).not.toHaveBeenCalled()

    const storage = AgentStorage.open(data)
    const coordinator = new AgentRuntimeCoordinator(storage, undefined, database => new AgentRuntime(database,
      async (_thread, _database, context) => ({
        agent: createDeepAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }), checkpointer: database.checkpointer,
          middleware: [createAgentRunLifecycleMiddleware(context?.requestId)] }) as never,
        dispose: async () => {}
      }), join(root, 'tmp'), async () => {}))
    try {
      const snapshot = await coordinator.getSnapshot(thread.id)
      expect(snapshot.messages.some(message => JSON.stringify(message.content).includes('Keep my original message'))).toBe(true)
      const database = storage.conversationForThread(thread.id)
      const tuple = await database.checkpointer.getTuple({ configurable: { thread_id: thread.id, checkpoint_ns: '' } })
      expect(tuple?.checkpoint.v).toBe(4)
      const changes = database.fileChanges.queryRoundFiles({ runId: run.id })
      expect(database.fileChanges.readRoundContent({ runId: run.id, version: changes.version, filePath: target }))
        .toMatchObject({ status: 'ready', before: 'before\n', after: 'after\n' })
      const events = []
      for await (const event of coordinator.forThread(thread.id).startRun({ runId: randomUUID(), threadId: thread.id, text: 'Continue this conversation' })) events.push(event)
      expect(events.at(-1)).toMatchObject({ type: 'run_completed' })
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
    const database = AgentDatabase.open(databases[1], join(data, 'attachments'))
    try {
      database.fileChanges.validateIntegrity()
      const source = (await database.fileChanges.load(run.id, operationId))!
      const inverseReference = source.transaction.recovery!.inverse!
      const inverse = (await database.fileChanges.load(inverseReference.requestId, inverseReference.operationId))!
      expect(source.transaction.state).toBe('resolved')
      expect(inverse.transaction.state).toBe('resolved')
      expect(inverse.transaction.restores?.definitionHash).toBe(source.definitionHash)
      expect(source.transaction.reverseAttempt?.definitionHash).toBe(inverse.definitionHash)
      expect(source.transaction.recovery?.inverse?.definitionHash).toBe(inverse.definitionHash)
      expect(await readFile(target, 'utf8')).toBe('Keep the current user content')
    } finally { database.close() }
  })

  it.each(['metadata', 'definition'])('handles a deleted inverse round during %s version repair', async field => {
    const { root, data, databases, thread, run, inverseRunId, operationId } = await archivedChangeFixture(0, 0, true)
    const storage = AgentStorage.open(data)
    try {
      const database = storage.conversationForThread(thread.id)
      await database.replaceMessageHistory(thread.id, [new HumanMessage({ id: 'original-message', content: 'Keep my original message',
        additional_kwargs: { anas_run_id: run.id } })], inverseRunId!)
    } finally { storage.close() }
    AgentDatabase.validateBackup(databases[1], join(data, 'attachments'), new Set([thread.projectId]), thread.id)
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
    expect(await readFile(join(result.preservationPath!, 'data/sqlite/conversations', `${thread.id}.sqlite`))).toEqual(original)
    if (field === 'definition') {
      expect(result.unresolved.join('\n')).toContain('unavailable in this archive')
      expect(await readFile(databases[1])).toEqual(original)
      return
    }
    expect(result.unresolved).toEqual([])
    AgentDatabase.validateBackup(databases[1], join(data, 'attachments'), new Set([thread.projectId]), thread.id)
    const repaired = new Database(databases[1], { readonly: true })
    try {
      const current = repaired.prepare('SELECT definition_json, metadata_json FROM agent_file_changes WHERE operation_id = ?').get(operationId) as typeof row
      expect(current.definition_json).toBe(row.definition_json)
      expect(JSON.parse(current.metadata_json)).toEqual(JSON.parse(row.metadata_json))
      expect(repaired.prepare('SELECT count(*) AS count FROM agent_file_changes').get()).toEqual({ count: 1 })
    } finally { repaired.close() }
    const database = AgentDatabase.open(databases[1], join(data, 'attachments'))
    try {
      expect((await database.fileChanges.load(run.id, operationId))?.transaction.state).toBe('resolved')
      const tuple = await database.checkpointer.getTuple({ configurable: { thread_id: thread.id, checkpoint_ns: '' } })
      expect(JSON.stringify(tuple?.checkpoint.channel_values.messages)).toContain('Keep my original message')
      await database.deleteThread(thread.id)
      expect(database.getThread(thread.id)).toBeNull()
    } finally { database.close() }
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
    const database = AgentDatabase.open(databases[1], join(data, 'attachments'))
    try {
      const inverse = (await database.fileChanges.load(inverseRunId!, inverseId))!
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
    const { root, data, databases, run, operationId } = await archivedChangeFixture(undefined)
    const recoveryDirectory = join(data, 'file_edits', run.id, operationId)
    await mkdir(recoveryDirectory, { recursive: true })
    await writeFile(join(recoveryDirectory, 'record.json'), 'preserve this recovery material')
    const original = await readFile(databases[1])
    const result = await repairRecoveryData(data, 'projects.json', () => preserveRecoveryData(data, root))
    expect(result.unresolved.join('\n')).toContain('still has recovery material')
    expect(await readFile(databases[1])).toEqual(original)
    expect(await readFile(join(recoveryDirectory, 'record.json'), 'utf8')).toBe('preserve this recovery material')
  })

  it('rejects replacement if recovery material appears after inspection', async () => {
    const { data, databases, run, operationId } = await archivedChangeFixture(undefined)
    const original = await readFile(databases[1])
    await expect(repairRecoveryData(data, 'projects.json', async () => {
      await mkdir(join(data, 'file_edits', run.id, operationId), { recursive: true })
      return '/preserved'
    })).rejects.toThrow('changed since inspection')
    expect(await readFile(databases[1])).toEqual(original)
  })

  it('preserves an orphan deletion stage before repairing project and database versions', async () => {
    const { root, data, projects, databases, thread } = await fixture()
    const stagePath = join(data, 'projects.json.delete-stage')
    const stage = `${JSON.stringify({ ...projects, version: 0 }, null, 2)}\n`
    await writeFile(stagePath, stage)
    const originals = await Promise.all(databases.map(path => readFile(path)))
    const plan = await inspectRecoveryRepair(data)
    expect(plan.files.find(file => file.name === 'projects.json')?.error).toBeUndefined()
    const preserve = vi.fn(async () => {
      expect(await readFile(stagePath, 'utf8')).toBe(stage)
      expect(JSON.parse(await readFile(join(data, 'projects.json'), 'utf8'))).toEqual(projects)
      for (const [index, path] of databases.entries()) expect(await readFile(path)).toEqual(originals[index])
      return preserveRecoveryData(data, root)
    })
    const result = await repairRecoveryData(data, 'projects.json', preserve)
    expect(preserve).toHaveBeenCalledOnce()
    expect(result.repaired).toHaveLength(3)
    expect(result.unresolved).toEqual([])
    expect(await readFile(stagePath, 'utf8')).toBe(stage)
    expect(await readFile(join(result.preservationPath!, 'data/projects.json.delete-stage'), 'utf8')).toBe(stage)
    expect(JSON.parse(await readFile(join(data, 'projects.json'), 'utf8'))).toEqual({ ...projects, version: 0 })
    const storage = AgentStorage.open(data)
    try { expect(storage.getThread(thread.id)?.title).toBe('Keep conversation') } finally { storage.close() }
  })

  it('leaves a journaled deletion transaction intact instead of treating it as an orphan stage', async () => {
    const { root, data, projects, databases } = await fixture()
    const previous = { version: 0, projects: [...projects.projects, { ...projects.projects[0], id: 'pending-project' }] }
    const next = { ...projects, version: 0 }
    const journal = { version: 0, projectId: 'pending-project', threadIds: [], previous, next }
    const paths = [join(data, 'projects.json'), join(data, 'projects.json.delete-stage'), join(data, 'projects.json.delete-journal'), ...databases]
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
    try { expect(db.pragma('user_version', { simple: true })).toBe(0) } finally { db.close() }
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
      expect(status.repairableFields.some(field => field.endsWith('user_version (9 → 0)'))).toBe(true)
      expect(await readFile(databases[1])).toEqual(before)
      expect(await readFile(`${databases[1]}-wal`)).toEqual(wal)
    } finally { db.close() }
  })

  it.each([0, 4])('repairs catalog and every conversation together with project version %s', async version => {
    const { root, data, projects, databases, thread } = await fixture(version)
    const before = await Promise.all(databases.map(path => readFile(path)))
    const inspected = await inspectRecoveryRepair(data)
    const status = inspected.files.find(file => file.name === 'projects.json')!
    expect(status.error).toBeUndefined()
    expect(status.repairableFields).toHaveLength(version === 0 ? 2 : 3)
    for (const [index, path] of databases.entries()) expect(await readFile(path)).toEqual(before[index])
    const result = await repairRecoveryData(data, 'projects.json', () => preserveRecoveryData(data, root))
    expect(result.unresolved).toEqual([])
    expect(await readFile(join(data, 'sqlite/agent.sqlite'), 'utf8')).toBe('unrelated historical data, preserved verbatim')
    expect(JSON.parse(await readFile(join(data, 'projects.json'), 'utf8'))).toEqual({ ...projects, version: 0 })
    expect(JSON.parse(await readFile(join(result.preservationPath!, 'data/projects.json'), 'utf8'))).toEqual(projects)
    for (const [index, path] of databases.entries()) {
      const db = new Database(path, { readonly: true })
      try { expect(db.pragma('user_version', { simple: true })).toBe(0) } finally { db.close() }
      const saved = join(result.preservationPath!, 'data', path.slice(data.length + 1))
      expect(await readFile(saved)).toEqual(before[index])
    }
    const storage = AgentStorage.open(data)
    try {
      expect(storage.getThread(thread.id)?.title).toBe('Keep conversation')
      const conversation = storage.conversationForThread(thread.id)
      expect(conversation.getRun('kept-run')?.status).toBe('completed')
      expect((await conversation.checkpointer.getTuple({ configurable: { thread_id: thread.id, checkpoint_ns: '' } }))?.checkpoint.id).toBe('kept-checkpoint')
      expect((await storage.memoryStore.searchMemories({ scope: 'global' })).items[0].content).toBe('Preserve this memory')
    } finally { storage.close() }
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
    const before = await Promise.all([join(data, 'projects.json'), ...databases].map(path => readFile(path)))
    const preserve = vi.fn(() => preserveRecoveryData(data, root))
    const result = await repairRecoveryData(data, 'projects.json', preserve)
    expect(result.repaired).toHaveLength(2)
    expect(result.unresolved.join('\n')).toContain(fault === 'schema' ? 'missing column' : 'missing project')
    expect(preserve).toHaveBeenCalledOnce()
    const damagedIndex = fault === 'schema' ? 1 : 0
    expect(await readFile(databases[damagedIndex])).toEqual(before[damagedIndex + 1])
    expect(JSON.parse(await readFile(join(data, 'projects.json'), 'utf8')).version).toBe(0)
    for (const [index, path] of [join(data, 'projects.json'), ...databases].entries()) {
      expect(await readFile(join(result.preservationPath!, 'data', path.slice(data.length + 1)))).toEqual(before[index])
    }
  })

  it('leaves all originals intact if preservation fails or data changes during preservation', async () => {
    const { data, databases } = await fixture()
    const paths = [join(data, 'projects.json'), ...databases]
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
