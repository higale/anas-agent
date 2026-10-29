import type { ExecutionToolCall } from '../runtime/executionState'
import type { NativeConversationDatabase } from './agent/nativeConversationDatabase'
import { toolEffectArtifactPurposes } from '../runtime/toolEffectIdentity'
import { defaultCapabilities, } from '@shared/agentCapabilities'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WORKSPACE_PROJECT_ID } from '@shared/types'

const paths = vi.hoisted(() => ({ projectFile: '' }))

vi.mock('./config/dataDir', async (importOriginal) => ({
  ...await importOriginal<typeof import('./config/dataDir')>(),
  getProjectStoreFile: () => paths.projectFile,
  getDefaultWorkspaceDir: () => join(root, 'default-workspace')
}))

vi.mock('./runtimeLogger', () => ({ runtimeLog: vi.fn() }))

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'anas-project-lifecycle-'))
  paths.projectFile = join(root, 'db/projects/state.json')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function busyRun(database: NativeConversationDatabase, threadId: string, status: 'running' | 'interrupted') {
  const runId = 'busy-run', id = 'busy-input'
  database.runs.createRun({ threadId, runId, operation: 'agent', message: { id, value: { id, kind: 'user', content: 'Question', context: { runId } } } })
  await database.runs.enter('input', { threadId, runId })
  if (status === 'running') return
  const { store } = database.runs
  const scope = () => ({ threadId, runId, expectedRevisionId: store.load(threadId)!.revisionId })
  const call = { id: 'pending-call', providerCallId: 'provider-call', name: 'update_config', args: {}, artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, `pending-call:${purpose}`])) as ExecutionToolCall['artifacts'] }
  store.acceptModel(scope(), { id: 'response', value: { kind: 'assistant', content: '', calls: [{ id: call.providerCallId, name: call.name, args: call.args }] } }, [call], { modelCalls: 1, todos: [] })
  store.prepareTools(scope(), [{ callId: call.id, args: call.args, authorization: { approval: 'pending' } }], [{
    id: 'approval', generation: 'generation', kind: 'tool', callIds: [call.id], request: {
      actionRequests: [{ name: call.name, args: call.args, description: 'Approve fixture' }],
      reviewConfigs: [{ actionName: call.name, allowedDecisions: ['approve', 'reject'] }] }
  }])
  expect(database.getThread(threadId)?.status).toBe('interrupted')
}

describe('project deletion lifecycle', () => {
  it.each(['simple_chat', 'default'] as const)('clears %s conversations while preserving the project, memories, and other projects', async (kind) => {
    const [{ AgentStorage }, { NativeRuntimeCoordinator }, projectStore] = await Promise.all([
      import('./agent/agentStorage'),
      import('./agent/nativeRuntimeCoordinator'),
      import('./projectStore')
    ])
    const project = kind === 'default'
      ? await projectStore.getProject(DEFAULT_WORKSPACE_PROJECT_ID)
      : await projectStore.createProject({ kind: 'simple_chat', name: 'Chat', prompt: '' })
    const storage = AgentStorage.openNative(root)
    const runtime = new NativeRuntimeCoordinator(storage, { push: vi.fn() }, { prepareWorkspace: false })
    try {
      const first = storage.createThread({ projectId: project.id })
      const second = storage.createThread({ projectId: project.id })
      storage.updateThread(second.id, { pinned: true })
      const otherProject = await projectStore.createProject({ kind: 'simple_chat', name: 'Other', prompt: '' })
      const other = storage.createThread({ projectId: otherProject.id })
      await storage.memoryStore.saveMemory({ scope: 'project', projectId: project.id,
        kind: 'fact', content: 'Keep this project memory', keywords: ['keep'], importance: 3 }, { origin: 'user' })

      const result = await runtime.deleteProjectThreads(project.id)

      expect(new Set(result.deletedThreadIds)).toEqual(new Set([first.id, second.id]))
      expect(storage.getThread(first.id)).toBeNull()
      expect(storage.getThread(second.id)).toBeNull()
      expect(storage.getThread(other.id)).not.toBeNull()
      expect(await projectStore.getProject(project.id)).toEqual(project)
      await expect(storage.memoryStore.searchMemories({ scope: 'project', projectId: project.id }))
        .resolves.toMatchObject({ total: 1 })
      await expect(runtime.deleteProjectThreads(project.id)).resolves.toMatchObject({ deletedThreadIds: [] })
      await expect(runtime.deleteProjectThreads('missing')).rejects.toThrow('was not found')
      expect(storage.getThread(other.id)).not.toBeNull()
    } finally {
      await runtime.shutdown()
      storage.close()
    }
  }, 15_000)

  it.each(['running', 'interrupted'] as const)('keeps all project conversations when one is %s', async (status) => {
    const [{ AgentStorage }, { NativeRuntimeCoordinator }, projectStore] = await Promise.all([
      import('./agent/agentStorage'), import('./agent/nativeRuntimeCoordinator'), import('./projectStore')
    ])
    const project = await projectStore.createProject({ kind: 'simple_chat', name: 'Chat', prompt: '' })
    const storage = AgentStorage.openNative(root)
    const runtime = new NativeRuntimeCoordinator(storage, { push: vi.fn() }, { prepareWorkspace: false })
    try {
      const idle = storage.createThread({ projectId: project.id })
      const busy = storage.createThread({ projectId: project.id })
      await busyRun(storage.conversationForThread(busy.id), busy.id, status)
      storage.refreshConversation(busy.id)
      await expect(runtime.deleteProjectThreads(project.id)).rejects.toThrow('is busy')
      expect(storage.getThread(idle.id)).not.toBeNull()
      expect(storage.getThread(busy.id)).not.toBeNull()
    } finally {
      await runtime.shutdown()
      storage.close()
    }
  }, 15_000)

  it('removes every conversation database before removing the project metadata', async () => {
    const [{ AgentStorage }, { NativeRuntimeCoordinator }, projectStore] = await Promise.all([
      import('./agent/agentStorage'),
      import('./agent/nativeRuntimeCoordinator'),
      import('./projectStore')
    ])
    const source = join(root, 'source')
    await mkdir(source)
    const project = await projectStore.createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '', kind: 'workspace', name: 'Project', sourceFolders: [source] })
    const storage = AgentStorage.openNative(root)
    const runtime = new NativeRuntimeCoordinator(storage, { push: vi.fn() }, { prepareWorkspace: false })
    try {
      const first = storage.createThread({ projectId: project.id })
      const second = storage.createThread({ projectId: project.id })
      const otherProject = await projectStore.createProject({ kind: 'simple_chat', name: 'Other', prompt: '' })
      const other = storage.createThread({ projectId: otherProject.id })

      const result = await runtime.deleteProject(project.id)

      expect(result.projectId).toBe(project.id)
      expect(new Set(result.deletedThreadIds)).toEqual(new Set([first.id, second.id]))
      expect(await projectStore.listProjects()).toEqual([
        expect.objectContaining({ id: otherProject.id }),
        expect.objectContaining({ id: DEFAULT_WORKSPACE_PROJECT_ID })
      ])
      expect(storage.getThread(first.id)).toBeNull()
      expect(storage.getThread(second.id)).toBeNull()
      expect(storage.getThread(other.id)).not.toBeNull()
    } finally {
      await runtime.shutdown()
      storage.close()
    }
  }, 15_000)

  it('rejects the whole deletion while any project thread is active or interrupted', async () => {
    const [{ AgentStorage }, { NativeRuntimeCoordinator }, projectStore] = await Promise.all([
      import('./agent/agentStorage'),
      import('./agent/nativeRuntimeCoordinator'),
      import('./projectStore')
    ])
    const source = join(root, 'source')
    await mkdir(source)
    const project = await projectStore.createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '', kind: 'workspace', name: 'Project', sourceFolders: [source] })
    const storage = AgentStorage.openNative(root)
    const runtime = new NativeRuntimeCoordinator(storage, { push: vi.fn() }, { prepareWorkspace: false })
    try {
      const thread = storage.createThread({ projectId: project.id })
      await busyRun(storage.conversationForThread(thread.id), thread.id, 'interrupted')
      storage.refreshConversation(thread.id)

      await expect(runtime.deleteProject(project.id)).rejects.toThrow('is busy')

      expect(await projectStore.listProjects()).toEqual([
        project,
        expect.objectContaining({ id: DEFAULT_WORKSPACE_PROJECT_ID })
      ])
      expect(storage.getThread(thread.id)).not.toBeNull()
    } finally {
      await runtime.shutdown()
      storage.close()
    }
  }, 15_000)
})
