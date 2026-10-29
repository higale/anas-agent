import Database from 'better-sqlite3'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import projectDefaults from '../../data/config/projects.json'
import { defaultCapabilities, serializeCapabilities } from '../shared/agentCapabilities'
import { writeProjectFixture } from '../test/projectDirectories'
import { AgentStorage } from './agent/agentStorage'
import { configFileNames, getAgentConversationDatabaseFile, getProjectStoreFile } from './config/dataDir'
import { readProjectStoreFile } from './projectStore'
import { inspectRecoveryRepair, repairRecoveryData } from './recoveryRepair'
import { preserveRecoveryData } from './recoveryData'
import { validateExecutionStorageDirectory } from './executionStorageValidation'
import { validateRestoredDataDirectory } from './dataRestoreValidation'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(parentDirectory = tmpdir()) {
  await mkdir(parentDirectory, { recursive: true })
  const parent = await mkdtemp(join(parentDirectory, 'anas-usable-recovery-'))
  roots.push(parent)
  const root = join(parent, 'data')
  await mkdir(join(root, 'config'), { recursive: true })
  for (const name of configFileNames) await cp(join(process.cwd(), 'data/config', name), join(root, 'config', name))
  const { version: _version, ...defaults } = projectDefaults
  const document = { version: 0, projects: [{ ...defaults, capabilities: serializeCapabilities(defaultCapabilities),
    id: 'default-workspace', kind: 'workspace', name: 'Retained name', pinned: false, collapsed: false,
    prompt: 'Retained prompt', restrict_subagents: false, sourceFolders: ['D:/retained-source'], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }] }
  await writeProjectFixture(root, document)
  const storage = AgentStorage.openNative(root)
  const good = storage.createThread({ title: 'Healthy conversation' })
  const bad = storage.createThread({ title: 'Damaged conversation' })
  await storage.memoryStore.saveMemory({ scope: 'global', kind: 'fact', content: 'Keep memory', keywords: [], importance: 3 }, { origin: 'user' })
  storage.close()
  return { parent, root, good, bad, document }
}

it('keeps desktop metadata from triggering or blocking repair, startup and restore validation', async () => {
  const f = await fixture()
  const metadata = ['db/projects/.DS_Store', 'db/projects/default-workspace/conversations/.DS_Store']
  for (const path of metadata) await writeFile(join(f.root, path), 'Finder metadata')
  const status = (await inspectRecoveryRepair(f.root)).files.find(file => file.name === 'projects.json')!
  expect(status.error).toBeFalsy()
  expect(status.repairableFields).toEqual([])
  await expect(readProjectStoreFile(getProjectStoreFile(f.root))).resolves.toBeDefined()
  const db = new Database(join(f.root, 'db/catalog.sqlite'))
  db.pragma('user_version=99'); db.close()
  const repaired = await repairRecoveryData(f.root, 'projects.json', () => preserveRecoveryData(f.root, f.parent))
  expect(repaired.readyToRestart).toBe(true)
  expect(repaired.unresolved).toEqual([])
  await cp(join(process.cwd(), 'data/subagents'), join(f.root, 'subagents'), { recursive: true })
  await validateRestoredDataDirectory(f.root)
  for (const path of metadata) expect(await readFile(join(f.root, path), 'utf8')).toBe('Finder metadata')
})

it('ignores unrelated files and directories and retains them through independent data repair', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'db/projects/unexpected.txt'), 'Preserve unexpected data')
  await mkdir(join(f.root, 'db/projects/personal notes'), { recursive: true })
  await writeFile(join(f.root, 'db/projects/personal notes/notes.txt'), 'User notes')
  await mkdir(join(f.root, 'db/projects/default-workspace/conversations/empty-folder'))
  const status = (await inspectRecoveryRepair(f.root)).files.find(file => file.name === 'projects.json')!
  expect(status.error).toBeFalsy()
  expect(status.repairableFields).toEqual([])
  const db = new Database(join(f.root, 'db/catalog.sqlite'))
  db.pragma('user_version=99'); db.close()
  const repaired = await repairRecoveryData(f.root, 'projects.json', () => preserveRecoveryData(f.root, f.parent))
  expect(repaired.readyToRestart).toBe(true)
  expect(repaired.unresolved).toEqual([])
  expect(await readFile(join(repaired.preservationPath!, 'data/db/projects/unexpected.txt'), 'utf8')).toBe('Preserve unexpected data')
  expect(await readFile(join(f.root, 'db/projects/personal notes/notes.txt'), 'utf8')).toBe('User notes')
  await cp(join(process.cwd(), 'data/subagents'), join(f.root, 'subagents'), { recursive: true })
  await validateRestoredDataDirectory(f.root)
})

it.each(['conversation', 'catalog', 'project'])('returns usable project data after %s corruption while preserving independent content and originals', async fault => {
  const f = await fixture()
  const damaged = fault === 'conversation' ? getAgentConversationDatabaseFile(f.bad.id, f.root)
    : fault === 'catalog' ? join(f.root, 'db/catalog.sqlite') : join(f.root, 'db/projects/default-workspace/project.json')
  await writeFile(damaged, 'unreadable original bytes')
  const plan = await inspectRecoveryRepair(f.root)
  expect(plan.files.find(file => file.name === 'projects.json')?.error).toBeTruthy()
  const result = await repairRecoveryData(f.root, 'projects.json', () => preserveRecoveryData(f.root, f.parent))
  expect(result.readyToRestart).toBe(true)
  expect(await readFile(join(result.preservationPath!, 'data', damaged.slice(f.root.length + 1)), 'utf8')).toBe('unreadable original bytes')
  await validateExecutionStorageDirectory(f.root)
  const definitions = await readProjectStoreFile(getProjectStoreFile(f.root))
  if (fault !== 'project') expect(definitions.projects[0]).toMatchObject({ sourceFolders: ['D:/retained-source'] })
  const storage = AgentStorage.openNative(f.root)
  try {
    expect(storage.conversationForThread(f.good.id).getThread(f.good.id)?.title).toBe('Healthy conversation')
    expect(storage.listThreads()).toHaveLength(fault === 'conversation' ? 1 : 2)
    expect(storage.createThread({ title: 'New conversation after recovery' }).title).toBe('New conversation after recovery')
    if (fault !== 'catalog') expect((await storage.memoryStore.searchMemories({ scope: 'global' })).total).toBe(1)
  } finally { storage.close() }
})

it('uses the durable pending project write instead of overwriting it with pre-transaction metadata', async () => {
  const f = await fixture(join(process.cwd(), 'tmp'))
  f.document.projects[0].prompt = 'Pending user change'
  const journal = JSON.stringify({ version: 0, next: f.document, removed: [] })
  await writeFile(join(f.root, 'db/project-write.json'), journal)
  const db = new Database(join(f.root, 'db/catalog.sqlite'))
  db.pragma('user_version=99'); db.close()
  const result = await repairRecoveryData(f.root, 'projects.json', () => preserveRecoveryData(f.root, f.parent))
  expect(result.readyToRestart).toBe(true)
  expect((await readProjectStoreFile(getProjectStoreFile(f.root))).projects[0].prompt).toBe('Pending user change')
  expect(await readFile(join(result.preservationPath!, 'data/db/project-write.json'), 'utf8')).toBe(journal)
  await expect(readFile(join(f.root, 'db/project-write.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('repairs missing projects and conversations without trapping the application behind catalog references', async () => {
  const f = await fixture()
  await rm(join(f.root, 'db/projects'), { recursive: true })
  const result = await repairRecoveryData(f.root, 'projects.json', () => preserveRecoveryData(f.root, f.parent))
  expect(result.readyToRestart).toBe(true)
  await validateExecutionStorageDirectory(f.root)
  const storage = AgentStorage.openNative(f.root)
  try {
    expect(storage.listThreads()).toEqual([])
    expect((await storage.memoryStore.searchMemories({ scope: 'global' })).total).toBe(1)
    storage.createThread()
  } finally { storage.close() }
})

it('reconstructs a complete project when both definition and UI state are missing', async () => {
  const f = await fixture()
  await rm(getProjectStoreFile(f.root))
  await rm(join(f.root, 'db/projects/default-workspace/project.json'))
  const result = await repairRecoveryData(f.root, 'projects.json', () => preserveRecoveryData(f.root, f.parent))
  expect(result.readyToRestart).toBe(true)
  const storage = AgentStorage.openNative(f.root)
  try { expect(storage.conversationForThread(f.good.id).getThread(f.good.id)?.title).toBe('Healthy conversation') } finally { storage.close() }
  expect((await readProjectStoreFile(getProjectStoreFile(f.root))).projects[0]).toMatchObject({ kind: 'workspace', restrictSubagents: false })
})

it('reconstructs missing workspace state before declaring repaired storage usable', async () => {
  const f = await fixture()
  const db = new Database(join(f.root, 'db/catalog.sqlite'))
  db.exec('DELETE FROM agent_workspace_state; PRAGMA user_version=99;')
  db.close()
  const result = await repairRecoveryData(f.root, 'projects.json', () => preserveRecoveryData(f.root, f.parent))
  expect(result.readyToRestart).toBe(true)
  const storage = AgentStorage.openNative(f.root)
  try {
    expect(storage.getWorkspaceState()).toMatchObject({ mode: 'new_thread', projectId: 'default-workspace' })
    storage.setWorkspaceState({ mode: 'thread', threadId: f.good.id })
    expect(storage.getWorkspaceState()).toEqual({ mode: 'thread', threadId: f.good.id })
  } finally { storage.close() }
})

it.each(['extra-fields', 'invalid-list', 'duplicate-ids'])('detects damaged UI state (%s) and never uses it to overwrite project definitions', async fault => {
  const f = await fixture()
  const path = getProjectStoreFile(f.root)
  const state = JSON.parse(await readFile(path, 'utf8'))
  if (fault === 'extra-fields') state.projects[0].prompt = 'Wrong prompt from UI state'
  if (fault === 'invalid-list') state.projects = 'invalid'
  if (fault === 'duplicate-ids') state.projects.push(state.projects[0])
  const original = JSON.stringify(state)
  await writeFile(path, original)
  const plan = await inspectRecoveryRepair(f.root)
  const status = plan.files.find(file => file.name === 'projects.json')!
  expect(Boolean(status.error) || status.repairableFields.length > 0).toBe(true)
  const result = await repairRecoveryData(f.root, 'projects.json', () => preserveRecoveryData(f.root, f.parent))
  expect(result.readyToRestart).toBe(true)
  expect((await readProjectStoreFile(path)).projects[0].prompt).toBe('Retained prompt')
  expect(await readFile(join(result.preservationPath!, 'data/db/projects/state.json'), 'utf8')).toBe(original)
})

it.each(['catalog', 'conversation'])('isolates an invalid %s SQLite sidecar directory while salvaging the database', async kind => {
  const f = await fixture()
  const file = kind === 'catalog' ? join(f.root, 'db/catalog.sqlite') : getAgentConversationDatabaseFile(f.good.id, f.root)
  await mkdir(`${file}-wal`)
  await writeFile(join(`${file}-wal`, 'original.txt'), 'Preserve unexpected sidecar content')
  const result = await repairRecoveryData(f.root, 'projects.json', () => preserveRecoveryData(f.root, f.parent))
  expect(result.readyToRestart).toBe(true)
  expect(await readFile(join(result.preservationPath!, 'data', file.slice(f.root.length + 1) + '-wal', 'original.txt'), 'utf8')).toBe('Preserve unexpected sidecar content')
  const storage = AgentStorage.openNative(f.root)
  try {
    expect(storage.listThreads()).toHaveLength(2)
    expect((await storage.memoryStore.searchMemories({ scope: 'global' })).total).toBe(1)
  } finally { storage.close() }
})
