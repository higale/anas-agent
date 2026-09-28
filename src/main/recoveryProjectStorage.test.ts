import Database from 'better-sqlite3'
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

describe('project version metadata recovery', () => {
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
