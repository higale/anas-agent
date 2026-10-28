import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentStorage } from './agentStorage'
import { getAgentCatalogFile } from '../config/dataDir'
import { SqliteMemoryStore } from './memoryStore'

const openDatabases: Array<{close():void}> = []
const temporaryRoots: string[] = []

function openMemoryStore(): SqliteMemoryStore {
  const database = new Database(':memory:')
  openDatabases.push(database)
  return new SqliteMemoryStore(database)
}

afterEach(async () => {
  while (openDatabases.length > 0) openDatabases.pop()?.close()
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('SqliteMemoryStore', () => {
  it('rolls back the record and search index together when a write fails', async () => {
    const database = new Database(':memory:')
    openDatabases.push(database)
    const store = new SqliteMemoryStore(database)
    const original = await store.saveMemory({ scope: 'global', kind: 'fact', content: 'Original searchable memory',
      keywords: ['original'], importance: 3 }, { origin: 'user' })
    // Fail after replacing the record and removing its previous search entry.
    // The transaction must restore both representations.
    const prepare = database.prepare.bind(database)
    const fault = vi.spyOn(database, 'prepare').mockImplementation(sql => {
      if (sql.includes('INSERT INTO agent_memory_fts')) throw new Error('Injected index failure')
      return prepare(sql)
    })
    try {
      await expect(store.saveMemory({ id: original.id, scope: 'global', kind: 'fact', content: 'Replacement memory',
        keywords: [], importance: 1 }, { origin: 'user' })).rejects.toThrow('Injected index failure')
    } finally { fault.mockRestore() }
    await expect(store.searchMemories({ query: 'original' })).resolves.toMatchObject({ total: 1,
      items: [{ id: original.id, content: original.content, updatedAt: original.updatedAt }] })
    expect(database.prepare('SELECT content FROM agent_memory_fts').all()).toEqual([{ content: original.content }])
    await store.deleteMemory(original.id)
    expect(database.prepare('SELECT content FROM agent_memory_fts').all()).toEqual([])
    await expect(store.searchMemories()).resolves.toEqual({ total: 0, items: [] })
  })

  it('reads existing stored memory rows without rewriting their identity or provenance', async () => {
    const database = new Database(':memory:')
    openDatabases.push(database)
    const store = new SqliteMemoryStore(database)
    const id = '11111111-1111-4111-8111-111111111111'
    const timestamp = '2026-09-01T08:00:00.000Z'
    const value = JSON.stringify({ kind: 'fact', content: 'Existing memory', keywords: [], importance: 3,
      origin: 'agent', sourceThreadId: 'thread', sourceRunId: 'run' })
    database.prepare('INSERT INTO agent_store_items VALUES (?, ?, ?, ?, ?)')
      .run(JSON.stringify(['memories', 'global']), id, value, timestamp, timestamp)
    await expect(store.searchMemories()).resolves.toMatchObject({ total: 1, items: [{
      id, content: 'Existing memory', origin: 'agent', sourceThreadId: 'thread', sourceRunId: 'run',
      createdAt: timestamp, updatedAt: timestamp
    }] })
    expect(database.prepare('SELECT value_json FROM agent_store_items').get()).toEqual({ value_json: value })
  })

  it('persists shared memory records in catalog.sqlite across restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-memory-store-'))
    temporaryRoots.push(root)
    const first = AgentStorage.openNative(root)
    await first.memoryStore.saveMemory({
      scope: 'global',
      kind: 'fact',
      content: 'Persisted across restart',
      keywords: ['restart'],
      importance: 4
    }, { origin: 'user' })
    first.close()

    const reopened = AgentStorage.openNative(root)
    openDatabases.push(reopened)

    await expect(reopened.memoryStore.searchMemories({ query: 'restart' })).resolves.toMatchObject({
      total: 1,
      items: [{ content: 'Persisted across restart' }]
    })
  })

  it('clears all memories without deleting retained non-memory rows', async () => {
    const database = new Database(':memory:')
    openDatabases.push(database)
    const store = new SqliteMemoryStore(database)
    const retained = JSON.stringify({ content: 'Keep this value' })
    database.prepare('INSERT INTO agent_store_items VALUES (?, ?, ?, ?, ?)')
      .run(JSON.stringify(['custom', 'namespace']), 'keep', retained, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
    await store.saveMemory({
      scope: 'global',
      kind: 'fact',
      content: 'Remove the global memory',
      keywords: ['remove-global'],
      importance: 3
    }, { origin: 'user' })
    await store.saveMemory({
      scope: 'project',
      projectId: 'project-1',
      kind: 'preference',
      content: 'Remove the project memory',
      keywords: ['remove-project'],
      importance: 4
    }, { origin: 'agent' })

    expect(store.clearMemories()).toBe(2)
    await expect(store.searchMemories()).resolves.toMatchObject({ total: 0, items: [] })
    await expect(store.searchMemories({ query: 'remove' })).resolves.toMatchObject({ total: 0, items: [] })
    expect(database.prepare('SELECT value_json FROM agent_store_items WHERE key = ?').get('keep')).toEqual({ value_json: retained })
  })

  it('returns freed database pages to disk when compacted after cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-memory-compact-'))
    temporaryRoots.push(root)
    const file = getAgentCatalogFile(root)
    const database = AgentStorage.openNative(root)
    openDatabases.push(database)
    for (let index = 0; index < 32; index += 1) {
      await database.memoryStore.saveMemory({
        scope: 'global',
        kind: 'fact',
        content: `${index}: ${'memory content '.repeat(256)}`,
        keywords: [`memory-${index}`],
        importance: 3
      }, { origin: 'user' })
    }
    await database.compact()
    const populatedSize = (await stat(file)).size

    database.memoryStore.clearMemories()
    await database.compact()

    expect((await stat(file)).size).toBeLessThan(populatedSize)
  })

  it('searches English and Chinese memory text without an embedding model', async () => {
    const store = openMemoryStore()
    await store.saveMemory({
      scope: 'global',
      kind: 'preference',
      content: 'Prefer concise TypeScript explanations.',
      keywords: ['TypeScript', 'concise'],
      importance: 4
    }, { origin: 'user' })
    await store.saveMemory({
      scope: 'global',
      kind: 'preference',
      content: 'Prefer concise Python explanations.',
      keywords: ['Python', 'concise'],
      importance: 4
    }, { origin: 'user' })
    await store.saveMemory({
      scope: 'project',
      projectId: 'project-1',
      kind: 'fact',
      content: '这个项目使用结构化长期记忆。',
      keywords: ['记忆系统'],
      importance: 5
    }, { origin: 'agent', sourceThreadId: 'thread-1' })

    await expect(store.searchMemories({ query: 'TypeScript concise' })).resolves.toMatchObject({
      total: 1,
      items: [{ kind: 'preference', scope: 'global' }]
    })
    await expect(store.searchMemories({ query: '结构化记忆' })).resolves.toMatchObject({
      total: 1,
      items: [{ kind: 'fact', projectId: 'project-1' }]
    })
  })

  it('requires lexical matches instead of accepting trigram fragments or metadata fields', async () => {
    const store = openMemoryStore()
    await store.saveMemory({
      scope: 'global',
      kind: 'fact',
      content: 'Other notes said formatting belongs elsewhere.',
      keywords: ['formatting'],
      importance: 5
    }, { origin: 'agent' })
    await store.saveMemory({
      scope: 'global',
      kind: 'preference',
      content: 'The preferred formatter is Biome.',
      keywords: ['biome'],
      importance: 3
    }, { origin: 'user' })

    await expect(store.searchMemories({ query: 'the' })).resolves.toMatchObject({
      total: 1,
      items: [{ content: 'The preferred formatter is Biome.' }]
    })
    await expect(store.searchMemories({ query: 'ai' })).resolves.toMatchObject({ total: 0, items: [] })
    for (const query of ['fact', 'agent', 'importance']) {
      await expect(store.searchMemories({ query })).resolves.toMatchObject({ total: 0, items: [] })
    }
  })

  it('extracts Latin search terms next to CJK text without requiring spaces', async () => {
    const store = openMemoryStore()
    await store.saveMemory({
      scope: 'global',
      kind: 'fact',
      content: 'SVN repositories live under the development directory.',
      keywords: ['svn'],
      importance: 4
    }, { origin: 'user' })

    for (const query of ['更新我的所有svn项目', '更新我的所有 svn 项目', '更新全部SVN仓库']) {
      await expect(store.searchMemories({ query })).resolves.toMatchObject({
        total: 1,
        items: [{ kind: 'fact', scope: 'global' }]
      })
    }
  })

  it('recalls only global and current-project records', async () => {
    const store = openMemoryStore()
    for (const [scope, projectId, content] of [
      ['global', undefined, 'The build command is npm run build.'],
      ['project', 'project-1', 'Project one build command uses npm run build.'],
      ['project', 'project-2', 'Project two build command uses npm run build.']
    ] as const) {
      await store.saveMemory({
        scope,
        ...(projectId ? { projectId } : {}),
        kind: 'fact',
        content,
        keywords: ['build'],
        importance: 3
      }, { origin: 'user' })
    }

    const recalled = await store.relevantMemories('build command', 'project-1', 8)

    expect(recalled.map((memory) => memory.content)).toContain('The build command is npm run build.')
    expect(recalled.map((memory) => memory.content)).toContain('Project one build command uses npm run build.')
    expect(recalled.map((memory) => memory.content)).not.toContain('Project two build command uses npm run build.')
  })

  it('prevents agent writes and deletion from crossing project scope', async () => {
    const store = openMemoryStore()
    const memory = await store.saveMemory({
      scope: 'project',
      projectId: 'project-2',
      kind: 'fact',
      content: 'Project two only',
      keywords: [],
      importance: 3
    }, { origin: 'user' })

    await expect(store.saveMemory({
      id: memory.id,
      scope: 'project',
      projectId: 'project-1',
      kind: 'fact',
      content: 'Cross-scope update',
      keywords: [],
      importance: 3
    }, { origin: 'agent', accessProjectId: 'project-1' })).rejects.toThrow('not available')
    await expect(store.deleteMemory(memory.id, 'project-1')).rejects.toThrow('not available')
    await expect(store.searchMemories({
      scope: 'project',
      projectId: 'project-2'
    })).resolves.toMatchObject({ total: 1 })
  })

  it('updates, moves, filters, and deletes individual records', async () => {
    const store = openMemoryStore()
    const created = await store.saveMemory({
      scope: 'global',
      kind: 'fact',
      content: 'Initial fact',
      keywords: [],
      importance: 2
    }, { origin: 'user' })
    const updated = await store.saveMemory({
      id: created.id,
      scope: 'project',
      projectId: 'project-1',
      kind: 'experience',
      content: 'Updated project experience',
      keywords: ['updated'],
      importance: 5
    }, { origin: 'agent' })

    expect(updated).toMatchObject({
      id: created.id,
      createdAt: created.createdAt,
      scope: 'project',
      projectId: 'project-1',
      kind: 'experience',
      origin: 'user'
    })
    await expect(store.searchMemories({ scope: 'global' })).resolves.toMatchObject({ total: 0 })
    await expect(store.searchMemories({
      scope: 'project',
      projectId: 'project-1',
      kind: 'experience'
    })).resolves.toMatchObject({ total: 1 })

    await store.deleteMemory(created.id)

    await expect(store.searchMemories()).resolves.toMatchObject({ total: 0, items: [] })
  })
})
